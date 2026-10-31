import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMessageBody, extractNetflixInsights, normalizeGmailMessage } from '../src/gmail-message.js';

function encode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

test('extracts plain text body from single-part payload', () => {
  const payload = {
    mimeType: 'text/plain',
    body: {
      data: encode('Netflix plain text body'),
    },
  };

  assert.equal(extractMessageBody(payload), 'Netflix plain text body');
});

test('extracts fallback text from multipart html payload', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      {
        mimeType: 'text/html',
        body: {
          data: encode('<p>Netflix <strong>HTML</strong> body</p>'),
        },
      },
    ],
  };

  assert.equal(extractMessageBody(payload), 'Netflix HTML body');
});

test('normalizes Gmail message metadata and body', () => {
  const message = {
    id: 'abc123',
    threadId: 'thread-1',
    internalDate: '1712486400000',
    snippet: 'Fallback snippet',
    payload: {
      headers: [
        { name: 'Subject', value: 'Netflix notice' },
        { name: 'From', value: 'Netflix <info@mailer.netflix.com>' },
        { name: 'Date', value: 'Sun, 07 Apr 2024 10:00:00 +0000' },
      ],
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/plain',
          body: {
            data: encode('Your Netflix plan changed'),
          },
        },
      ],
    },
  };

  const normalized = normalizeGmailMessage(message);

  assert.equal(normalized.subject, 'Netflix notice');
  assert.equal(normalized.from, 'Netflix <info@mailer.netflix.com>');
  assert.equal(normalized.body, 'Your Netflix plan changed');
  assert.equal(normalized.permalink, 'https://mail.google.com/mail/u/0/#inbox/abc123');
  assert.equal(normalized.category, 'billing');
});

test('extracts Netflix household confirmation CTA link and access code from HTML email', () => {
  const insights = extractNetflixInsights({
    subject: 'Your Netflix temporary access code',
    body: 'Enter this verification code: 482910 to watch on your TV.',
    html: '<p>Requested by TV</p><a href="https://www.netflix.com/account/travel/verify?token=abc">Get Code</a>',
  });

  assert.equal(insights.category, 'household');
  assert.equal(insights.extractedCode, '482910');
  assert.equal(insights.ctaUrl, 'https://www.netflix.com/account/travel/verify?token=abc');
  assert.equal(insights.ctaLabel, 'Get Code');
});
