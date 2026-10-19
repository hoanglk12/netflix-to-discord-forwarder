import test from 'node:test';
import assert from 'node:assert/strict';
import { toPublicCheckpoint } from '../src/checkpoint.js';

const urlA = 'https://discord.com/api/webhooks/1111111111/secret-token-a';
const urlB = 'https://discord.com/api/v10/webhooks/2222222222/secret-token-b?thread_id=9';

function sampleCheckpoint() {
  return {
    version: 2,
    day: '2026-10-19',
    sentCount: 0,
    sentIds: [],
    lastOnceLatestIds: ['m1', 'm2'],
    lastOnceRunAt: '2026-10-19T08:00:00.000Z',
    lastSuccessAt: null,
    lastSentDiscordMessages: [
      { webhookUrl: urlA, messageId: 'd1' },
      { webhookUrl: urlB, messageId: 'd2' },
    ],
  };
}

test('replaces webhook URLs with the webhook id and its index in the configured list', () => {
  const view = toPublicCheckpoint(sampleCheckpoint(), [urlB, urlA]);

  assert.deepEqual(view.lastSentDiscordMessages, [
    { messageId: 'd1', webhookId: '1111111111', webhookIndex: 1 },
    { messageId: 'd2', webhookId: '2222222222', webhookIndex: 0 },
  ]);
  assert.deepEqual(view.lastOnceLatestIds, ['m1', 'm2']);
  assert.equal(JSON.stringify(view).includes('secret-token'), false);
});

test('uses null for webhooks that are no longer configured or do not parse', () => {
  const checkpoint = sampleCheckpoint();
  checkpoint.lastSentDiscordMessages.push(
    { webhookUrl: 'not a url', messageId: 'd3' },
    { messageId: 'd4' },
    null,
  );

  const view = toPublicCheckpoint(checkpoint, []);

  assert.deepEqual(view.lastSentDiscordMessages, [
    { messageId: 'd1', webhookId: '1111111111', webhookIndex: null },
    { messageId: 'd2', webhookId: '2222222222', webhookIndex: null },
    { messageId: 'd3', webhookId: null, webhookIndex: null },
    { messageId: 'd4', webhookId: null, webhookIndex: null },
    { messageId: null, webhookId: null, webhookIndex: null },
  ]);
  assert.equal(JSON.stringify(view).includes('secret-token'), false);
});

test('drops any extra fields an entry carries', () => {
  const checkpoint = sampleCheckpoint();
  checkpoint.lastSentDiscordMessages = [{ webhookUrl: urlA, messageId: 'd1', debugUrl: urlA }];

  const view = toPublicCheckpoint(checkpoint, [urlA]);

  assert.deepEqual(view.lastSentDiscordMessages, [
    { messageId: 'd1', webhookId: '1111111111', webhookIndex: 0 },
  ]);
});

test('does not modify the stored checkpoint it was given', () => {
  const checkpoint = sampleCheckpoint();
  const before = structuredClone(checkpoint);

  toPublicCheckpoint(checkpoint, [urlA, urlB]);

  assert.deepEqual(checkpoint, before);
});

test('passes through values without tracked posts', () => {
  assert.equal(toPublicCheckpoint(null, [urlA]), null);
  assert.deepEqual(toPublicCheckpoint({ status: 'Not initialized' }, [urlA]), { status: 'Not initialized' });
});
