import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, MAX_WEBHOOK_URLS } from './config.js';
import { authorizeGmail } from './gmail.js';
import { createLogger } from './logger.js';
import { runPollCycle } from './poller.js';
import {
  CHECKPOINT_REDIS_KEY,
  createEmptyState,
  getRedisCredentials,
  loadCheckpoint,
  normalizeState,
  saveCheckpoint,
  setCheckpointCache,
  toPublicCheckpoint,
} from './checkpoint.js';
import { deleteDiscordMessage, sendTestWebhookPing } from './discord.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let gmailPromise = null;
let isRunning = false;
let lastRunResult = null;

const WEBHOOK_REDIS_KEY = 'netflix-forwarder:webhook-urls';
const LOGS_REDIS_KEY = 'netflix-forwarder:logs';
const LOCK_REDIS_KEY = 'netflix-forwarder:run-lock';
const MAX_REDIS_LOGS = 100;
const WEBHOOK_CACHE_TTL_MS = 15000;

let webhookCache = null;
let webhookCacheAt = 0;
let logsCache = null;
let logsCacheAt = 0;

function formatLogTimestamp(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

async function getRedisClient() {
  const credentials = getRedisCredentials();
  if (!credentials) return null;
  const { Redis } = await import('@upstash/redis');
  return new Redis(credentials);
}

async function loadRedisWebhookUrls() {
  if (webhookCache && Date.now() - webhookCacheAt < WEBHOOK_CACHE_TTL_MS) {
    return [...webhookCache];
  }

  try {
    const redis = await getRedisClient();
    if (!redis) return null;
    const urls = await redis.get(WEBHOOK_REDIS_KEY);
    if (!Array.isArray(urls) || urls.length === 0) return null;
    webhookCache = [...urls];
    webhookCacheAt = Date.now();
    return [...webhookCache];
  } catch (error) {
    console.error('Failed to load webhook URLs from Redis', error);
    return null;
  }
}

async function saveRedisWebhookUrls(urls) {
  const redis = await getRedisClient();
  if (!redis) {
    throw new Error(
      'Cannot save webhook URLs: Upstash Redis is not configured. ' +
      'Connect the Upstash Redis integration to this project (sets ' +
      'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN or KV_REST_API_URL / ' +
      'KV_REST_API_TOKEN), then redeploy.',
    );
  }

  await redis.set(WEBHOOK_REDIS_KEY, urls);
  webhookCache = [...urls];
  webhookCacheAt = Date.now();
}

async function appendRedisLogs(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  try {
    const redis = await getRedisClient();
    if (!redis) return;
    const pipe = redis.pipeline();
    for (const line of lines) {
      pipe.lpush(LOGS_REDIS_KEY, line);
    }
    pipe.ltrim(LOGS_REDIS_KEY, 0, MAX_REDIS_LOGS - 1);
    await pipe.exec();
    logsCache = null;
  } catch (error) {
    console.error('Failed to append logs to Redis', error);
  }
}

async function getCoreServices({ withWebhooks = false } = {}) {
  const config = loadConfig({ requireWebhook: false });

  if (withWebhooks && process.env.VERCEL) {
    const storedUrls = await loadRedisWebhookUrls();
    if (storedUrls && storedUrls.length > 0) {
      config.discordWebhookUrls = storedUrls;
    }
  }

  const logger = createLogger(config.logFilePath);
  return { config, logger };
}

async function getGmailService() {
  if (!gmailPromise) {
    const config = loadConfig({ requireWebhook: false });
    gmailPromise = authorizeGmail(config, { allowInteractive: false }).catch((err) => {
      gmailPromise = null;
      const isInvalidGrant = err.message?.includes('invalid_grant') || err.code === 'invalid_grant';
      if (isInvalidGrant) {
        throw new Error(
          'Gmail token expired or revoked (invalid_grant). ' +
          'Re-run `npm run auth` locally to get a fresh token, ' +
          'then update GMAIL_TOKEN_JSON_BASE64 in Vercel environment variables.',
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
    storageMode: process.env.VERCEL ? 'upstash-redis' : 'local-file',
    region: process.env.VERCEL_REGION || (process.env.VERCEL ? 'sin1' : 'local'),
  };
}

export async function getLogsView(lines = 50) {
  const { config } = await getCoreServices();

  if (process.env.VERCEL) {
    if (logsCache && Date.now() - logsCacheAt < 10000) {
      return { logs: logsCache.slice(0, lines) };
    }
    try {
      const redis = await getRedisClient();
      if (redis) {
        const redisLogs = await redis.lrange(LOGS_REDIS_KEY, 0, lines - 1);
        if (Array.isArray(redisLogs) && redisLogs.length > 0) {
          logsCache = redisLogs;
          logsCacheAt = Date.now();
          return { logs: redisLogs };
        }
      }
    } catch {
      // fall through to local file
    }
  }

  try {
    const content = await fs.readFile(config.logFilePath, 'utf8');
    const logs = content.split('\n').filter((line) => line.trim()).slice(-lines).reverse();
    return { logs };
  } catch {
    return { logs: [] };
  }
}

export async function getCheckpointView() {
  const { config } = await getCoreServices({ withWebhooks: true });
  try {
    const checkpoint = await loadCheckpoint(config.checkpointPath, config.checkpointMaxIds);
    return toPublicCheckpoint(checkpoint, config.discordWebhookUrls);
  } catch {
    return { status: 'Not initialized' };
  }
}

/**
 * Consolidated single-round-trip snapshot endpoint.
 * On Vercel, uses a single Upstash Redis pipeline to fetch webhooks, checkpoint, and logs in 1 HTTP call.
 */
export async function getSnapshotView() {
  const config = loadConfig({ requireWebhook: false });

  if (process.env.VERCEL) {
    try {
      const redis = await getRedisClient();
      if (redis) {
        const pipe = redis.pipeline();
        pipe.get(WEBHOOK_REDIS_KEY);
        pipe.get(CHECKPOINT_REDIS_KEY);
        pipe.lrange(LOGS_REDIS_KEY, 0, 49);
        const [storedUrls, rawCheckpoint, redisLogs] = await pipe.exec();

        if (Array.isArray(storedUrls) && storedUrls.length > 0) {
          config.discordWebhookUrls = storedUrls;
          webhookCache = [...storedUrls];
          webhookCacheAt = Date.now();
        }
        if (rawCheckpoint) {
          setCheckpointCache(rawCheckpoint);
        }
        if (Array.isArray(redisLogs)) {
          logsCache = redisLogs;
          logsCacheAt = Date.now();
        }

        const normalizedCkpt = normalizeState(rawCheckpoint || createEmptyState(), config.checkpointMaxIds);
        return {
          config: {
            gmailQuery: config.gmailQuery,
            gmailSenderFilter: config.gmailSenderFilter,
            forwardLatestCount: config.forwardLatestCount,
            gmailFetchLimit: config.gmailFetchLimit,
            discordWebhookUrls: config.discordWebhookUrls.map((u) => `${u.slice(0, 50)}...`),
          },
          status: {
            isRunning,
            lastRunResult,
            gmailConfigured: true,
            storageMode: 'upstash-redis',
            region: process.env.VERCEL_REGION || 'sin1',
          },
          checkpoint: toPublicCheckpoint(normalizedCkpt, config.discordWebhookUrls),
          logs: Array.isArray(redisLogs) ? redisLogs : [],
        };
      }
    } catch (error) {
      console.error('Redis pipeline snapshot failed, falling back to individual reads', error);
    }
  }

  const [configView, statusView, checkpointView, logsView] = await Promise.all([
    getConfigView(),
    getStatusView(),
    getCheckpointView(),
    getLogsView(50),
  ]);

  return {
    config: configView,
    status: statusView,
    checkpoint: checkpointView,
    logs: logsView.logs || [],
  };
}

export async function runNow() {
  if (isRunning) {
    return { status: 409, data: { error: 'Poll already running' } };
  }

  const { config, logger } = await getCoreServices({ withWebhooks: true });
  if (config.discordWebhookUrls.length === 0) {
    return { status: 400, data: { error: 'No Discord webhook URLs configured. Add one via the channel panel first.' } };
  }

  let redisLockAcquired = false;
  const redis = process.env.VERCEL ? await getRedisClient() : null;
  if (redis) {
    try {
      const lockRes = await redis.set(LOCK_REDIS_KEY, String(Date.now()), { nx: true, ex: 60 });
      if (!lockRes) {
        return { status: 409, data: { error: 'Poll already running on another instance' } };
      }
      redisLockAcquired = true;
    } catch {
      // Proceed with local lock if Redis lock fails
    }
  }

  const runLogs = [];
  const timestampedLogs = [];
  const capturingLogger = {
    info(message, details) {
      const suffix = details ? ` ${JSON.stringify(details)}` : '';
      runLogs.push(`INFO ${message}${suffix}`);
      timestampedLogs.push(`${formatLogTimestamp()} INFO ${message}${suffix}`);
      return logger.info(message, details);
    },
    warn(message, details) {
      const suffix = details ? ` ${JSON.stringify(details)}` : '';
      runLogs.push(`WARN ${message}${suffix}`);
      timestampedLogs.push(`${formatLogTimestamp()} WARN ${message}${suffix}`);
      return logger.warn(message, details);
    },
    error(message, details) {
      const suffix = details ? ` ${JSON.stringify(details)}` : '';
      runLogs.push(`ERROR ${message}${suffix}`);
      timestampedLogs.push(`${formatLogTimestamp()} ERROR ${message}${suffix}`);
      return logger.error(message, details);
    },
  };

  isRunning = true;
  try {
    const gmail = await getGmailService();
    lastRunResult = await runPollCycle({ gmail, config, logger: capturingLogger });
    if (process.env.VERCEL && timestampedLogs.length > 0) {
      await appendRedisLogs(timestampedLogs);
    }
    const checkpoint = await getCheckpointView();
    return { status: 200, data: { ...lastRunResult, logs: runLogs, checkpoint } };
  } catch (error) {
    capturingLogger.error('Poll cycle failed', { error: error.message });
    if (process.env.VERCEL && timestampedLogs.length > 0) {
      await appendRedisLogs(timestampedLogs);
    }
    return {
      status: 500,
      data: { error: error.message, logs: runLogs },
    };
  } finally {
    isRunning = false;
    if (redis && redisLockAcquired) {
      try {
        await redis.del(LOCK_REDIS_KEY);
      } catch {
        // Ignore lock cleanup errors
      }
    }
  }
}

export async function deleteAllSentMessages() {
  const { config, logger } = await getCoreServices({ withWebhooks: true });
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

  const logMsg = `${formatLogTimestamp()} INFO Deleted previous Discord messages ${JSON.stringify({ deleted, failed })}`;
  if (process.env.VERCEL) {
    await appendRedisLogs([logMsg]);
  } else {
    await logger.info('Deleted previous Discord messages', { deleted, failed });
  }

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
    await saveRedisWebhookUrls(urls);
    return;
  }

  const envPath = path.resolve(__dirname, '../.env');
  let raw = '';
  try {
    raw = await fs.readFile(envPath, 'utf8');
  } catch {
    raw = '';
  }
  const lines = raw ? raw.split('\n') : [];
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

  if (!Number.isInteger(index) || index < 0 || index >= urls.length) {
    return { status: 400, data: { error: 'Invalid webhook index' } };
  }

  urls.splice(index, 1);
  await persistWebhookUrls(urls);

  return { status: 200, data: { message: 'Webhook URL removed', count: urls.length } };
}

export async function testWebhookByIndex(index) {
  const { config, logger } = await getCoreServices({ withWebhooks: true });
  const urls = config.discordWebhookUrls;

  if (!Number.isInteger(index) || index < 0 || index >= urls.length) {
    return { status: 400, data: { error: 'Invalid webhook channel index' } };
  }

  const targetUrl = urls[index];
  try {
    const result = await sendTestWebhookPing(targetUrl);
    const logLine = `${formatLogTimestamp()} INFO Sent diagnostic ping to Discord channel #${index + 1}`;
    if (process.env.VERCEL) {
      await appendRedisLogs([logLine]);
    } else {
      await logger.info(`Sent diagnostic ping to Discord channel #${index + 1}`, { messageId: result?.messageId });
    }
    return {
      status: 200,
      data: {
        message: `Test ping delivered to Channel #${index + 1}`,
        messageId: result?.messageId || null,
      },
    };
  } catch (error) {
    return {
      status: 502,
      data: { error: `Webhook ping failed: ${error.message}` },
    };
  }
}
