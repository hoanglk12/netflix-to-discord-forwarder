import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiscordPayload } from '../src/discord.js';

function sampleMessage(overrides = {}) {
  return {
    id: '19d67ed7cf4bd071',
    subject: 'Netflix payment reminder',
    from: 'Netflix <info@mailer.netflix.com>',
    date: 'Tue, 07 Apr 2026 10:00:00 +0000',
    internalDate: String(Date.UTC(2026, 3, 7, 10, 0, 0)),
    snippet: 'Your monthly plan invoice is ready.',
    body: 'Your monthly plan invoice is ready. Please check your payment method before your next billing date.',
    permalink: 'https://mail.google.com/mail/u/0/#inbox/19d67ed7cf4bd071',
    ...overrides,
  };
}

test('builds a rich discord payload with sender metadata and preview', () => {
  const payload = buildDiscordPayload(sampleMessage());

  assert.equal(payload.username, 'Netflix Forwarder');
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].fields[0].name, 'Sender');
  assert.equal(payload.embeds[0].fields[1].name, 'Sender Email');
  assert.equal(payload.embeds[0].fields[2].name, 'Received');
  assert.equal(payload.embeds[0].fields[3].name, 'Preview');
  assert.match(payload.embeds[0].fields[2].value, /<t:\d+:F>/);
});

test('sanitizes mentions and enforces preview limits', () => {
  const payload = buildDiscordPayload(sampleMessage({
    body: `Hello @everyone ${'x'.repeat(2000)}`,
  }));

  const preview = payload.embeds[0].fields[3].value;
  assert.equal(preview.includes('@everyone'), false);
  assert.equal(preview.length <= 1000, true);
});
