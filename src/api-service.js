import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, MAX_WEBHOOK_URLS } from './config.js';
import { authorizeGmail } from './gmail.js';
import { createLogger } from './logger.js';
import { runPollCycle } from './poller.js';
import { loadCheckpoint, saveCheckpoint } from './checkpoint.js';
import { deleteDiscordMessage } from './discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let gmailPromise = null;
let isRunning = false;
let lastRunResult = null;

const WEBHOOK_EDGE_CONFIG_KEY = 'webhookUrls';
const WEBHOOK_CACHE_TTL_MS = 30000;

let webhookCache = null;
let webhookCacheAt = 0;

// EDGE_CONFIG is a connection string like https://edge-config.vercel.com/<id>?token=<read-token>
function getEdgeConfigId() {
  const connection = process.env.EDGE_CONFIG;
  if (!connection) return null;
  try {
    return new URL(connection).pathname.split('/').filter(Boolean)[0] || null;
  } catch {
    return null;
  }
}

async function loadEdgeConfigWebhookUrls() {
  if (!process.env.EDGE_CONFIG) return null;

  if (webhookCache && Date.now() - webhookCacheAt < WEBHOOK_CACHE_TTL_MS) {
    // Return a copy: callers (addWebhookUrl/removeWebhookUrl) mutate the
    // array in place, and that must not silently corrupt the shared cache.
    return [...webhookCache];
  }

  try {
    const { get } = await import('@vercel/edge-config');
    const urls = await get(WEBHOOK_EDGE_CONFIG_KEY);
    if (!Array.isArray(urls) || urls.length === 0) return null;
    webhookCache = [...urls];
    webhookCacheAt = Date.now();
    return [...webhookCache];
  } catch {
    return null;
  }
}

// Edge Config reads go through the low-latency edge SDK, but writes require
// the Vercel management REST API (a VERCEL_API_TOKEN with account/team access).
async function saveEdgeConfigWebhookUrls(urls) {
  const edgeConfigId = getEdgeConfigId();
  if (!edgeConfigId || !process.env.VERCEL_API_TOKEN) {
    throw new Error(
      'Cannot save webhook URLs: Edge Config is not fully configured. ' +
      'Connect an Edge Config store to this project (sets EDGE_CONFIG) and add a ' +
      'VERCEL_API_TOKEN environment variable, then redeploy.',
    );
  }

  const params = new URLSearchParams();
  if (process.env.VERCEL_TEAM_ID) params.set('teamId', process.env.VERCEL_TEAM_ID);

  const res = await fetch(`https://api.vercel.com/v1/edge-config/${edgeConfigId}/items?${params}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${process.env.VERCEL_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: [{ operation: 'upsert', key: WEBHOOK_EDGE_CONFIG_KEY, value: urls }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Failed to save webhook URLs to Edge Config (${res.status}): ${detail}`);
  }

  webhookCache = [...urls];
  webhookCacheAt = Date.now();
}

async function getCoreServices({ withWebhooks = false } = {}) {
  const config = loadConfig();

  if (withWebhooks && process.env.VERCEL) {
    const storedUrls = await loadEdgeConfigWebhookUrls();
    if (storedUrls && storedUrls.length > 0) {
      config.discordWebhookUrls = storedUrls;
    }
  }

  const logger = createLogger(config.logFilePath);
  return { config, logger };
}

async function getGmailService() {
  if (!gmailPromise) {
    const config = loadConfig();
    gmailPromise = authorizeGmail(config, { allowInteractive: false }).catch((err) => {
      gmailPromise = null;
      const isInvalidGrant = err.message?.includes('invalid_grant') || err.code === 'invalid_grant';
      if (isInvalidGrant) {
        throw new Error(
          'Gmail token expired or revoked (invalid_grant). ' +
          'Re-run `npm run auth` locally to get a fresh token, ' +
          'then update GMAIL_TOKEN_JSON in Vercel environment variables.',
        );
      }
      throw err;
    });
  }
  return gmailPromise;
}

export async function getConfigView() {
  const { config } = await getCoreServices({ withWebhooks: true });
  return {
    gmailQuery: config.gmailQuery,
    gmailSenderFilter: config.gmailSenderFilter,
    forwardLatestCount: config.forwardLatestCount,
    gmailFetchLimit: config.gmailFetchLimit,
    discordWebhookUrls: config.discordWebhookUrls.map((u) => `${u.slice(0, 50)}...`),
  };
}

export async function getStatusView() {
  await getCoreServices();
  return {
    isRunning,
    lastRunResult,
    gmailConfigured: true,
  };
}

export async function getLogsView(lines = 5) {
  const { config } = await getCoreServices();
  try {
    const content = await fs.readFile(config.logFilePath, 'utf8');
    const logs = content.split('\n').filter((line) => line.trim()).slice(-lines).reverse();
    return { logs };
  } catch {
    return { logs: [] };
  }
}

export async function getCheckpointView() {
  const { config } = await getCoreServices();
  try {
    return await loadCheckpoint(config.checkpointPath, config.checkpointMaxIds);
  } catch {
    return { status: 'Not initialized' };
  }
}

export async function runNow() {
  if (isRunning) {
    return { status: 409, data: { error: 'Poll already running' } };
  }

  const { config, logger } = await getCoreServices({ withWebhooks: true });
  const gmail = await getGmailService();

  const runLogs = [];
  const capturingLogger = {
    info(message, details) {
      runLogs.push(`INFO ${message}${details ? ` ${JSON.stringify(details)}` : ''}`);
      return logger.info(message, details);
    },
    warn(message, details) {
      runLogs.push(`WARN ${message}${details ? ` ${JSON.stringify(details)}` : ''}`);
      return logger.warn(message, details);
    },
    error(message, details) {
      runLogs.push(`ERROR ${message}${details ? ` ${JSON.stringify(details)}` : ''}`);
      return logger.error(message, details);
    },
  };

  isRunning = true;
  try {
    lastRunResult = await runPollCycle({ gmail, config, logger: capturingLogger });
    const checkpoint = await getCheckpointView();
    return { status: 200, data: { ...lastRunResult, logs: runLogs, checkpoint } };
  } catch (error) {
    return {
      status: 500,
      data: { error: error.message, logs: runLogs },
    };
  } finally {
    isRunning = false;
  }
}

export async function deleteAllSentMessages() {
  const { config, logger } = await getCoreServices();
  const checkpoint = await loadCheckpoint(config.checkpointPath, config.checkpointMaxIds);
  const messages = checkpoint.lastSentDiscordMessages || [];

  if (messages.length === 0) {
    return { status: 200, data: { noMessages: true, deleted: 0, failed: 0, message: 'No message to delete' } };
  }

  const remaining = [];
  let deleted = 0;
  let failed = 0;

  for (const entry of messages) {
    const { webhookUrl, messageId } = entry;
    if (!webhookUrl || !messageId) continue;

    try {
      await deleteDiscordMessage(webhookUrl, messageId);
      deleted += 1;
    } catch (error) {
      failed += 1;
      remaining.push(entry);
      await logger.warn('Failed to delete Discord message', { messageId, error: error.message });
    }
  }

  await saveCheckpoint(config.checkpointPath, { ...checkpoint, lastSentDiscordMessages: remaining });

  return {
    status: 200,
    data: {
      noMessages: false,
      deleted,
      failed,
      message: failed > 0
        ? `Deleted ${deleted} message(s), ${failed} failed and will be retried later`
        : `Deleted ${deleted} message(s)`,
    },
  };
}

async function persistWebhookUrls(urls) {
  const value = urls.join(',');
  process.env.DISCORD_WEBHOOK_URL = value;

  if (process.env.VERCEL) {
    await saveEdgeConfigWebhookUrls(urls);
    return;
  }

  const envPath = path.resolve(__dirname, '../.env');
  const raw = await fs.readFile(envPath, 'utf8');
  const lines = raw.split('\n');
  const key = 'DISCORD_WEBHOOK_URL';
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index >= 0) {
    lines[index] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
  await fs.writeFile(envPath, lines.join('\n'), 'utf8');
}

export async function addWebhookUrl(nextUrl) {
  if (!nextUrl || !nextUrl.startsWith('https://')) {
    return { status: 400, data: { error: 'Invalid webhook URL. Must start with https://' } };
  }

  const { config } = await getCoreServices({ withWebhooks: true });
  const urls = config.discordWebhookUrls;

  if (urls.length >= MAX_WEBHOOK_URLS) {
    return { status: 400, data: { error: `Maximum ${MAX_WEBHOOK_URLS} webhook URLs allowed` } };
  }

  if (urls.includes(nextUrl)) {
    return { status: 400, data: { error: 'This webhook URL already exists' } };
  }

  urls.push(nextUrl);
  await persistWebhookUrls(urls);

  return { status: 200, data: { message: 'Webhook URL added', count: urls.length } };
}

export async function removeWebhookUrl(index) {
  const { config } = await getCoreServices({ withWebhooks: true });
  const urls = config.discordWebhookUrls;

  if (urls.length <= 1) {
    return { status: 400, data: { error: 'Cannot remove the last webhook URL' } };
  }

  if (index < 0 || index >= urls.length) {
    return { status: 400, data: { error: 'Invalid webhook index' } };
  }

  urls.splice(index, 1);
  await persistWebhookUrls(urls);

  return { status: 200, data: { message: 'Webhook URL removed', count: urls.length } };
}
