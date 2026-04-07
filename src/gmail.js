import fs from 'node:fs/promises';
import path from 'node:path';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';
import { normalizeGmailMessage } from './gmail-message.js';
import { withRetry } from './utils.js';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

async function loadSavedToken(tokenPath) {
  if (process.env.GMAIL_TOKEN_JSON?.trim()) {
    return JSON.parse(process.env.GMAIL_TOKEN_JSON);
  }

  try {
    const raw = await fs.readFile(tokenPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
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

async function createOAuthClient(config, allowInteractive) {
  const savedToken = await loadSavedToken(config.gmailTokenPath);
  if (savedToken) {
    const auth = new google.auth.GoogleAuth({
      credentials: savedToken,
      scopes: SCOPES,
    });
    return auth.getClient();
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