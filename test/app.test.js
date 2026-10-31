import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/app.js';

test('GET /api/snapshot returns unified config, status, checkpoint, and logs payload', async () => {
  const res = await app.request('http://localhost:3000/api/snapshot');
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(typeof body.config, 'object');
  assert.equal(typeof body.status, 'object');
  assert.equal(typeof body.checkpoint, 'object');
  assert.equal(Array.isArray(body.logs), true);
});

test('POST /api/config rejects cross-origin write requests on unified router', async () => {
  const res = await app.request('http://localhost:3000/api/config', {
    method: 'POST',
    headers: {
      Host: 'localhost:3000',
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'add', webhookUrl: 'https://discord.com/api/webhooks/1/a' }),
  });

  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /Cross-origin/i);
});
