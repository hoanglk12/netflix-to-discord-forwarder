import 'dotenv/config';
import path from 'node:path';

const cwd = process.cwd();

function resolveFromCwd(value, fallback) {
  const raw = value && value.trim() ? value.trim() : fallback;
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

function getRequired(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getPositiveInt(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }

  return parsed;
}

export function loadConfig() {
  const senderFilter = process.env.GMAIL_SENDER_FILTER?.trim() || 'netflix.com';
  const queryOverride = process.env.GMAIL_QUERY?.trim();
  const gmailTokenJson = process.env.GMAIL_TOKEN_JSON?.trim() || null;
  const gmailCredentialsJson = process.env.GMAIL_OAUTH_CREDENTIALS_JSON?.trim() || null;

  const gmailTokenPath = process.env.GMAIL_TOKEN_PATH?.trim()
    ? resolveFromCwd(process.env.GMAIL_TOKEN_PATH, './secrets/gmail-token.json')
    : null;
  const gmailCredentialsPath = process.env.GMAIL_OAUTH_CREDENTIALS_PATH?.trim()
    ? resolveFromCwd(process.env.GMAIL_OAUTH_CREDENTIALS_PATH, './secrets/gmail-oauth-client.json')
    : null;

  return {
    gmailCredentialsPath,
    gmailTokenPath,
    gmailCredentialsJson,
    gmailTokenJson,
    discordWebhookUrl: getRequired('DISCORD_WEBHOOK_URL'),
    pollIntervalMs: getPositiveInt('POLL_INTERVAL_MS', 60000),
    gmailSenderFilter: senderFilter,
    gmailQuery: queryOverride || 'in:inbox newer_than:1d',
    checkpointPath: resolveFromCwd(process.env.CHECKPOINT_PATH, './data/checkpoint.json'),
    logFilePath: resolveFromCwd(process.env.LOG_FILE_PATH, './output/app.log'),
    gmailFetchLimit: getPositiveInt('GMAIL_FETCH_LIMIT', 25),
    forwardLatestCount: getPositiveInt('FORWARD_LATEST_COUNT', 5),
    checkpointMaxIds: getPositiveInt('CHECKPOINT_MAX_IDS', 250),
  };
}