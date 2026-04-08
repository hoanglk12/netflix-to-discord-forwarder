import { truncate } from './utils.js';

function createDiscordError(message, retryAfterMs, status) {
  const error = new Error(message);
  error.retryAfterMs = retryAfterMs;
  error.status = status;
  return error;
}

function formatDescription(message) {
  const sourceText = message.body || message.snippet || '(empty body)';
  return truncate(sourceText, 4000);
}

function extractSenderEmail(from) {
  if (!from) {
    return '(unknown)';
  }

  const bracketMatch = from.match(/<([^>]+)>/);
  if (bracketMatch?.[1]) {
    return bracketMatch[1];
  }

  const plainMatch = from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return plainMatch?.[0] || '(unknown)';
}

function toDiscordTime(internalDate) {
  const millis = Number.parseInt(String(internalDate), 10);
  if (!Number.isFinite(millis) || millis <= 0) {
    return '(unknown date)';
  }

  const unixSeconds = Math.floor(millis / 1000);
  return `<t:${unixSeconds}:F>\n<t:${unixSeconds}:R>`;
}

function formatPreview(message) {
  const text = (message.body || message.snippet || '(empty body)').replace(/@/g, '@\u200b');
  return truncate(text, 1000);
}

function toIsoTimestamp(internalDate) {
  const millis = Number.parseInt(String(internalDate), 10);
  if (!Number.isFinite(millis) || millis <= 0) {
    return new Date().toISOString();
  }
  return new Date(millis).toISOString();
}

export function buildDiscordPayload(message) {
  const senderEmail = extractSenderEmail(message.from);

  return {
    username: 'Netflix Forwarder',
    embeds: [
      {
        title: truncate(message.subject, 256),
        description: truncate(`**Open in Gmail:** ${message.permalink}\n\n${formatDescription(message)}`, 4000),
        color: 14875136,
        url: message.permalink,
        fields: [
          {
            name: 'Sender',
            value: truncate(message.from, 1024) || '(unknown sender)',
            inline: true,
          },
          {
            name: 'Sender Email',
            value: truncate(senderEmail, 1024),
            inline: true,
          },
          {
            name: 'Received',
            value: toDiscordTime(message.internalDate),
            inline: true,
          },
          {
            name: 'Preview',
            value: formatPreview(message),
            inline: false,
          },
        ],
        footer: {
          text: `Netflix Gmail Forwarder • ${truncate(message.id, 64)}`,
        },
        timestamp: toIsoTimestamp(message.internalDate),
      },
    ],
  };
}

export async function postToDiscord(webhookUrl, payload) {
  const url = new URL(webhookUrl);
  url.searchParams.set('wait', 'true');

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (response.ok) {
    try {
      const data = await response.json();
      return { messageId: data.id };
    } catch {
      return { messageId: null };
    }
  }

  if (response.status === 429) {
    let retryAfterMs = 0;
    try {
      const json = await response.json();
      retryAfterMs = Number(json.retry_after) || 0;
    } catch {
      retryAfterMs = 0;
    }
    throw createDiscordError('Discord rate limit hit.', retryAfterMs, response.status);
  }

  if (response.status >= 500) {
    throw createDiscordError(`Discord server error: ${response.status}`, null, response.status);
  }

  const body = await response.text();
  throw createDiscordError(`Discord webhook rejected request: ${response.status} ${body}`, null, response.status);
}

export function isRetriableDiscordError(error) {
  return error?.status === 429 || error?.status >= 500 || error?.cause?.code === 'ECONNRESET';
}

export async function deleteDiscordMessage(webhookUrl, messageId) {
  const url = new URL(webhookUrl);
  url.pathname = `${url.pathname}/messages/${messageId}`;

  const response = await fetch(url.toString(), { method: 'DELETE' });

  if (response.ok || response.status === 204) {
    return true;
  }

  if (response.status === 404) {
    return false;
  }

  if (response.status === 429) {
    let retryAfterMs = 0;
    try {
      const json = await response.json();
      retryAfterMs = Number(json.retry_after) || 0;
    } catch {
      retryAfterMs = 0;
    }
    throw createDiscordError('Discord rate limit hit during delete.', retryAfterMs, response.status);
  }

  return false;
}