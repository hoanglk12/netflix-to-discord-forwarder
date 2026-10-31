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

const CTA_LABEL_PATTERNS = [
  /get\s+code/i,
  /yes,?\s*this\s+was\s+me/i,
  /update\s+(?:netflix\s+)?household/i,
  /confirm\s+update/i,
  /verify\s+(?:email|device|account)/i,
  /reset\s+password/i,
  /approve/i,
  /send\s+code/i,
];

const CTA_URL_PATTERNS = [
  /netflix\.com\/account\/travel/i,
  /netflix\.com\/account\/update-primary-location/i,
  /netflix\.com\/verify/i,
  /netflix\.com\/password/i,
  /netflix\.com\/loginhelp/i,
];

export function extractNetflixInsights({ subject = '', body = '', html = '' }) {
  const combined = `${subject}\n${body}`;
  const lower = combined.toLowerCase();

  let category = 'general';
  if (/household|temporary access|traveling|update.*location|watch\s+on\s+tv/i.test(combined)) {
    category = 'household';
  } else if (/verification\s+code|sign-in\s+code|security\s+code|temporary\s+code|one-time\s+code/i.test(combined)) {
    category = 'verification';
  } else if (/new\s+sign-in|new\s+device|password\s+reset|password\s+was\s+changed|security\s+alert/i.test(combined)) {
    category = 'security';
  } else if (/payment|invoice|billing|membership|plan\s+change|subscription/i.test(lower)) {
    category = 'billing';
  }

  // Extract verification / access code (4-8 digits) when email is a code/household/security email
  let extractedCode = null;
  const explicitCodeMatch =
    combined.match(/(?:code\s*(?:is|:)|enter\s+code|verification\s+code|access\s+code)[:\s]*([0-9]{4,8})\b/i) ||
    html.match(/<(?:div|span|p|td|strong|h[1-4])[^>]*>\s*([0-9]{4}|[0-9]{6})\s*<\/(?:div|span|p|td|strong|h[1-4])>/i);

  if (explicitCodeMatch?.[1]) {
    const candidate = explicitCodeMatch[1];
    const num = Number(candidate);
    if (!(candidate.length === 4 && num >= 2020 && num <= 2035)) {
      extractedCode = candidate;
    }
  }

  // Extract CTA link from HTML anchors or plain text URLs
  let ctaUrl = null;
  let ctaLabel = null;

  if (html) {
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRegex.exec(html)) !== null) {
      const rawHref = match[1].replace(/&amp;/g, '&').trim();
      const label = chunkText(stripHtml(match[2]));
      if (!rawHref.startsWith('https://')) continue;

      const labelMatches = CTA_LABEL_PATTERNS.some((re) => re.test(label));
      const urlMatches = CTA_URL_PATTERNS.some((re) => re.test(rawHref));

      if (labelMatches || urlMatches) {
        ctaUrl = rawHref;
        ctaLabel = label || 'Open Netflix Link';
        break;
      }
    }
  }

  if (!ctaUrl && body) {
    const urlRegex = /https:\/\/(?:www\.)?netflix\.com\/[^\s)>"]+/gi;
    let match;
    while ((match = urlRegex.exec(body)) !== null) {
      const candidateUrl = match[0];
      if (CTA_URL_PATTERNS.some((re) => re.test(candidateUrl))) {
        ctaUrl = candidateUrl;
        ctaLabel = category === 'household' ? 'Verify Netflix Household' : 'Open Action Link';
        break;
      }
    }
  }

  return {
    category,
    extractedCode,
    ctaUrl,
    ctaLabel,
  };
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
  const collected = collectBodies(payload);
  const rawHtml = collected.html.join('\n');
  const body = extractMessageBody(payload, message.snippet || '');
  const insights = extractNetflixInsights({ subject, body, html: rawHtml });

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
    category: insights.category,
    extractedCode: insights.extractedCode,
    ctaUrl: insights.ctaUrl,
    ctaLabel: insights.ctaLabel,
  };
}
