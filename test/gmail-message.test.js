import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMessageBody, normalizeGmailMessage } from '../src/gmail-message.js';

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
});