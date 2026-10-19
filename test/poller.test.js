import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  hasExactDuplicateWindow,
  runPollCycle,
  selectLatestMatchingMessages,
  selectLatestMatchingMessagesForRun,
} from '../src/poller.js';

function gmailMessage(id) {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: '1712486400000',
    snippet: `Netflix message ${id}`,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Netflix <info@mailer.netflix.com>' },
        { name: 'Subject', value: `Message ${id}` },
      ],
      body: { data: Buffer.from(`Body ${id}`, 'utf8').toString('base64url') },
    },
  };
}

function createFakeGmail(inbox) {
  return {
    users: {
      messages: {
        list: async () => ({ data: { messages: inbox.current.map(({ id }) => ({ id })) } }),
        get: async ({ id }) => ({ data: inbox.current.find((message) => message.id === id) }),
      },
    },
  };
}

test('selects the latest five messages whose sender contains the configured domain', () => {
  const messages = [
    { id: '1', from: 'Netflix <a@mailer.netflix.com>', internalDate: 1 },
    { id: '2', from: 'Other <a@example.com>', internalDate: 2 },
    { id: '3', from: 'Netflix <b@mailer.netflix.com>', internalDate: 3 },
    { id: '4', from: 'Netflix <c@mailer.netflix.com>', internalDate: 4 },
    { id: '5', from: 'Netflix <d@mailer.netflix.com>', internalDate: 5 },
    { id: '6', from: 'Netflix <e@mailer.netflix.com>', internalDate: 6 },
    { id: '7', from: 'Netflix <f@mailer.netflix.com>', internalDate: 7 },
  ];

  const selected = selectLatestMatchingMessages(messages, {
    gmailSenderFilter: 'netflix.com',
    forwardLatestCount: 5,
  });

  assert.deepEqual(selected.map((message) => message.id), ['3', '4', '5', '6', '7']);
});

test('selects latest five messages as of run time in once mode', () => {
  const messages = [
    { id: '1', from: 'Netflix <a@mailer.netflix.com>', internalDate: 1 },
    { id: '2', from: 'Netflix <b@mailer.netflix.com>', internalDate: 2 },
    { id: '3', from: 'Netflix <c@mailer.netflix.com>', internalDate: 3 },
    { id: '4', from: 'Netflix <d@mailer.netflix.com>', internalDate: 4 },
    { id: '5', from: 'Netflix <e@mailer.netflix.com>', internalDate: 5 },
    { id: '6', from: 'Netflix <f@mailer.netflix.com>', internalDate: 6 },
    { id: '7', from: 'Netflix <g@mailer.netflix.com>', internalDate: 7 },
  ];

  const selected = selectLatestMatchingMessagesForRun(messages, {
    gmailSenderFilter: 'netflix.com',
    forwardLatestCount: 5,
  }, 6);

  assert.deepEqual(selected.map((message) => message.id), ['2', '3', '4', '5', '6']);
});

test('detects exact duplicate latest-five window', () => {
  const current = ['a', 'b', 'c', 'd', 'e'];
  const previous = ['a', 'b', 'c', 'd', 'e'];

  assert.equal(hasExactDuplicateWindow(current, previous, 5), true);
});

test('does not treat partial overlap as exact duplicate window', () => {
  const current = ['a', 'b', 'c', 'd', 'e'];
  const previous = ['a', 'b', 'x', 'd', 'e'];

  assert.equal(hasExactDuplicateWindow(current, previous, 5), false);
});

test('runs that post nothing keep tracking earlier Discord posts so the next post can delete them', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'poller-test-'));
  const originalFetch = globalThis.fetch;
  const originalVercel = process.env.VERCEL;
  delete process.env.VERCEL;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (originalVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = originalVercel;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const webhookUrl = 'https://discord.com/api/webhooks/111/token-a';
  const fetchCalls = [];
  let nextDiscordId = 1;
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ method: options.method, url: String(url) });
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ id: `discord-${nextDiscordId++}` }), { status: 200 });
  };

  const inbox = { current: [gmailMessage('a')] };
  const gmail = createFakeGmail(inbox);
  const logger = { info: async () => {}, warn: async () => {}, error: async () => {} };
  const config = {
    checkpointPath: path.join(tmpDir, 'checkpoint.json'),
    checkpointMaxIds: 250,
    gmailQuery: 'in:inbox',
    gmailFetchLimit: 25,
    gmailSenderFilter: 'netflix.com',
    forwardLatestCount: 1,
    discordWebhookUrls: [webhookUrl],
  };
  const readTrackedPosts = async () =>
    JSON.parse(await fs.readFile(config.checkpointPath, 'utf8')).lastSentDiscordMessages;
  const firstPost = [{ webhookUrl, messageId: 'discord-1' }];

  // Run 1 posts message "a".
  assert.equal((await runPollCycle({ gmail, config, logger })).sent, 1);
  assert.deepEqual(await readTrackedPosts(), firstPost);

  // Run 2 sees the same window and skips it as a duplicate.
  fetchCalls.length = 0;
  assert.equal((await runPollCycle({ gmail, config, logger })).skipped, 1);
  assert.deepEqual(fetchCalls, []);
  assert.deepEqual(await readTrackedPosts(), firstPost);

  // Run 3 finds no matching messages.
  inbox.current = [];
  assert.equal((await runPollCycle({ gmail, config, logger })).sent, 0);
  assert.deepEqual(fetchCalls, []);
  assert.deepEqual(await readTrackedPosts(), firstPost);

  // Run 4 posts message "b" and must delete the post from run 1 first.
  inbox.current = [gmailMessage('b')];
  assert.equal((await runPollCycle({ gmail, config, logger })).sent, 1);
  assert.deepEqual(fetchCalls[0], {
    method: 'DELETE',
    url: `${webhookUrl}/messages/discord-1`,
  });
  assert.deepEqual(await readTrackedPosts(), [{ webhookUrl, messageId: 'discord-2' }]);
});