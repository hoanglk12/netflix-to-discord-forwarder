import fs from 'node:fs/promises';
import path from 'node:path';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';
import { normalizeGmailMessage } from './gmail-message.js';
import { withRetry } from './utils.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function tryParseToken(raw) {
  if (!raw || typeof raw !== 'string') {
    return null;
  }

  const candidates = [
    raw,
    raw.trim(),
    raw.trim().replace(/^'+|'+$/g, ''),
    raw.trim().replace(/^"+|"+$/g, ''),
    raw.trim().replace(/\\"/g, '"'),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
      if (typeof parsed === 'string') {
        const parsedAgain = JSON.parse(parsed);
        if (parsedAgain && typeof parsedAgain === 'object') {
          return parsedAgain;
        }
      }
    } catch {
      // try next candidate
    }
  }

  return null;
}

function isValidToken(parsed) {
  return parsed && typeof parsed === 'object' && (parsed.refresh_token || parsed.access_token);
}

async function loadSavedToken(tokenPath) {
  if (process.env.GMAIL_TOKEN_JSON_BASE64?.trim()) {
    try {
      const decoded = Buffer.from(process.env.GMAIL_TOKEN_JSON_BASE64, 'base64').toString('utf8');
      const parsed = tryParseToken(decoded);
      if (parsed && isValidToken(parsed)) return parsed;
    } catch {
      throw new Error('Invalid GMAIL_TOKEN_JSON_BASE64 format. Expected base64 encoded JSON.');
    }
    throw new Error('GMAIL_TOKEN_JSON_BASE64 does not contain a valid OAuth token (missing refresh_token/access_token).');
  }

  if (process.env.GMAIL_TOKEN_JSON?.trim()) {
    const parsed = tryParseToken(process.env.GMAIL_TOKEN_JSON);
    if (!parsed) throw new Error('Invalid GMAIL_TOKEN_JSON format. Expected valid JSON object.');
    if (!isValidToken(parsed)) throw new Error('GMAIL_TOKEN_JSON does not contain a valid OAuth token (missing refresh_token/access_token).');
    return parsed;
  }

  try {
    const raw = await fs.readFile(tokenPath, 'utf8');
    const parsed = JSON.parse(raw);
    return isValidToken(parsed) ? parsed : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveToken(tokenPath, client) {
  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  const payload = {
    type: 'authorized_user',
    client_id: client._clientId,
    client_secret: client._clientSecret,
    refresh_token: client.credentials.refresh_token,
  };
  await fs.writeFile(tokenPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildOAuth2Client(savedToken) {
  const oauth2 = new google.auth.OAuth2(savedToken.client_id, savedToken.client_secret);
  oauth2.setCredentials({
    refresh_token: savedToken.refresh_token,
    access_token: savedToken.access_token,
    expiry_date: savedToken.expiry_date,
  });
  return oauth2;
}

async function createOAuthClient(config, allowInteractive) {
  const savedToken = await loadSavedToken(config.gmailTokenPath);
  if (savedToken) {
    return buildOAuth2Client(savedToken);
  }

  if (!allowInteractive) {
    throw new Error('Missing Gmail token. Set GMAIL_TOKEN_JSON or run npm run auth to create GMAIL_TOKEN_PATH.');
  }

  if (!config.gmailCredentialsPath) {
    throw new Error('Interactive auth requires GMAIL_OAUTH_CREDENTIALS_PATH.');
  }

  const client = await authenticate({
    scopes: SCOPES,
    keyfilePath: config.gmailCredentialsPath,
  });

  if (!client.credentials.refresh_token) {
    throw new Error('Interactive OAuth flow did not return a refresh token.');
  }

  await saveToken(config.gmailTokenPath, client);
  return client;
}

function isRetriableGoogleError(error) {
  const status = error?.code || error?.response?.status;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export async function authorizeGmail(config, options = {}) {
  const auth = await createOAuthClient(config, options.allowInteractive ?? false);
  return google.gmail({ version: 'v1', auth });
}

export async function fetchRecentMessages(gmail, config, logger) {
  const listResponse = await withRetry(
    () => gmail.users.messages.list({
      userId: 'me',
      q: config.gmailQuery,
      maxResults: config.gmailFetchLimit,
    }),
    {
      logger,
      taskName: 'gmail list',
      isRetriable: isRetriableGoogleError,
    },
  );

  const messageIds = listResponse.data.messages || [];
  const normalizedMessages = [];

  for (const entry of messageIds) {
    const detail = await withRetry(
      () => gmail.users.messages.get({
        userId: 'me',
        id: entry.id,
        format: 'full',
      }),
      {
        logger,
        taskName: 'gmail get',
        isRetriable: isRetriableGoogleError,
      },
    );

    normalizedMessages.push(normalizeGmailMessage(detail.data));
  }

  normalizedMessages.sort((left, right) => {
    if (left.internalDate !== right.internalDate) {
      return left.internalDate - right.internalDate;
    }
    return left.id.localeCompare(right.id);
  });

  return normalizedMessages;
}