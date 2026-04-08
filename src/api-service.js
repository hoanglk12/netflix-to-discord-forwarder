import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, MAX_WEBHOOK_URLS } from './config.js';
import { authorizeGmail } from './gmail.js';
import { createLogger } from './logger.js';
import { runPollCycle } from './poller.js';
import { loadCheckpoint } from './checkpoint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let gmailPromise = null;
let isRunning = false;
let lastRunResult = null;

const WEBHOOK_BLOB_PATH = 'webhook-config.json';

async function loadBlobWebhookUrls() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: WEBHOOK_BLOB_PATH });
    if (blobs.length === 0) return null;
    const res = await fetch(blobs[0].url);
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.urls) ? data.urls : null;
  } catch {
    return null;
  }
}

async function saveBlobWebhookUrls(urls) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  const { put } = await import('@vercel/blob');
  await put(WEBHOOK_BLOB_PATH, JSON.stringify({ urls }), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
  });
}

async function getCoreServices() {
  const config = loadConfig();

  if (process.env.VERCEL) {
    const storedUrls = await loadBlobWebhookUrls();
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
    gmailPromise = authorizeGmail(config, { allowInteractive: false });
  }
  return gmailPromise;
}

export async function getConfigView() {
  const { config } = await getCoreServices();
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

  const { config, logger } = await getCoreServices();
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

async function persistWebhookUrls(urls) {
  const value = urls.join(',');
  process.env.DISCORD_WEBHOOK_URL = value;

  if (process.env.VERCEL) {
    await saveBlobWebhookUrls(urls);
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

  const { config } = await getCoreServices();
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
  const { config } = await getCoreServices();
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
