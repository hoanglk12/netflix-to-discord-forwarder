import { chunkText } from './utils.js';

function decodeBase64Url(value) {
  if (!value) {
    return '';
  }

  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function findHeader(headers, name) {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function collectBodies(part, acc = { plain: [], html: [] }) {
  if (!part) {
    return acc;
  }

  if (part.mimeType === 'text/plain' && part.body?.data) {
    acc.plain.push(decodeBase64Url(part.body.data));
  }

  if (part.mimeType === 'text/html' && part.body?.data) {
    acc.html.push(decodeBase64Url(part.body.data));
  }

  if (Array.isArray(part.parts)) {
    for (const child of part.parts) {
      collectBodies(child, acc);
    }
  }

  return acc;
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export function extractMessageBody(payload, snippet = '') {
  const collected = collectBodies(payload);
  const plainText = chunkText(collected.plain.join('\n'));
  if (plainText) {
    return plainText;
  }

  const htmlText = chunkText(stripHtml(collected.html.join('\n')));
  if (htmlText) {
    return htmlText;
  }

  return chunkText(snippet || '');
}

export function normalizeGmailMessage(message) {
  const payload = message.payload || {};
  const subject = findHeader(payload.headers, 'Subject') || '(no subject)';
  const from = findHeader(payload.headers, 'From') || '(unknown sender)';
  const dateHeader = findHeader(payload.headers, 'Date');
  const internalDate = Number.parseInt(message.internalDate || '0', 10) || Date.now();
  const body = extractMessageBody(payload, message.snippet || '');

  return {
    id: message.id,
    threadId: message.threadId,
    subject,
    from,
    date: dateHeader || new Date(internalDate).toUTCString(),
    internalDate,
    snippet: chunkText(message.snippet || ''),
    body,
    permalink: `https://mail.google.com/mail/u/0/#inbox/${message.id}`,
  };
}