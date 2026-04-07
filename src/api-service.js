import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { authorizeGmail } from './gmail.js';
import { createLogger } from './logger.js';
import { runPollCycle } from './poller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let servicesPromise = null;
let isRunning = false;
let lastRunResult = null;

async function getServices() {
  if (!servicesPromise) {
    servicesPromise = (async () => {
      const config = loadConfig();
      const logger = createLogger(config.logFilePath);
      const gmail = await authorizeGmail(config, { allowInteractive: false });
      return { config, logger, gmail };
    })();
  }

  return servicesPromise;
}

export async function getConfigView() {
  const { config } = await getServices();
  return {
    gmailQuery: config.gmailQuery,
    gmailSenderFilter: config.gmailSenderFilter,
    forwardLatestCount: config.forwardLatestCount,
    gmailFetchLimit: config.gmailFetchLimit,
    discordWebhookUrl: `${config.discordWebhookUrl.slice(0, 50)}...`,
  };
}

export async function getStatusView() {
  await getServices();
  return {
    isRunning,
    lastRunResult,
    gmailConfigured: true,
  };
}

export async function getLogsView(lines = 5) {
  const { config } = await getServices();
  try {
    const content = await fs.readFile(config.logFilePath, 'utf8');
    const logs = content.split('\n').filter((line) => line.trim()).slice(-lines).reverse();
    return { logs };
  } catch {
    return { logs: [] };
  }
}

export async function getCheckpointView() {
  const { config } = await getServices();
  try {
    const content = await fs.readFile(config.checkpointPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return { status: 'Not initialized' };
  }
}

export async function runNow() {
  if (isRunning) {
    return { status: 409, data: { error: 'Poll already running' } };
  }

  const { config, logger, gmail } = await getServices();
  isRunning = true;
  try {
    lastRunResult = await runPollCycle({ gmail, config, logger });
    return { status: 200, data: lastRunResult };
  } catch (error) {
    return {
      status: 500,
      data: { error: error.message },
    };
  } finally {
    isRunning = false;
  }
}

export async function updateWebhookUrl(nextUrl) {
  if (!nextUrl || !nextUrl.startsWith('https://')) {
    return { status: 400, data: { error: 'Invalid webhook URL' } };
  }

  if (process.env.VERCEL) {
    return {
      status: 501,
      data: { error: 'Webhook update is disabled on Vercel. Update DISCORD_WEBHOOK_URL in Project Settings.' },
    };
  }

  const envPath = path.resolve(__dirname, '../.env');
  const raw = await fs.readFile(envPath, 'utf8');
  const lines = raw.split('\n');
  const key = 'DISCORD_WEBHOOK_URL';
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index >= 0) {
    lines[index] = `${key}=${nextUrl}`;
  } else {
    lines.push(`${key}=${nextUrl}`);
  }
  await fs.writeFile(envPath, lines.join('\n'), 'utf8');

  const services = await getServices();
  services.config.discordWebhookUrl = nextUrl;

  return { status: 200, data: { message: 'Discord webhook URL updated successfully' } };
}
