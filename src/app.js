import { Hono } from 'hono';
import {
  addWebhookUrl,
  deleteAllSentMessages,
  getCheckpointView,
  getConfigView,
  getLogsView,
  getSnapshotView,
  getStatusView,
  removeWebhookUrl,
  runNow,
  testWebhookByIndex,
} from './api-service.js';
import { isCrossOriginWrite } from './request-guard.js';

export const app = new Hono();

// Cross-origin write guard middleware for all /api/* routes
app.use('/api/*', async (c, next) => {
  const rawHeaders = Object.fromEntries(c.req.raw.headers.entries());
  const reqLike = {
    method: c.req.method,
    headers: rawHeaders,
  };

  if (isCrossOriginWrite(reqLike)) {
    return c.json({ error: 'Cross-origin request rejected' }, 403);
  }

  return next();
});

// Agentic Browsing discovery endpoints
app.get('/.well-known/ard.json', (c) => {
  return c.json({
    version: '1.0',
    name: 'Netflix to Discord Telemetry Console',
    description: 'Production telemetry console and automated Gmail-to-Discord forwarder for Netflix verification and household management.',
    url: 'https://netflix-to-discord-forwarder.vercel.app',
    resources: [
      {
        type: 'api',
        name: 'Telemetry Snapshot',
        url: '/api/snapshot',
        method: 'GET',
        description: 'Returns current forwarding configuration, poll status, deduplication window checkpoint, and recent logs in a single JSON payload.',
      },
      {
        type: 'api',
        name: 'Trigger Poll',
        url: '/api/poll',
        method: 'POST',
        description: 'Triggers an on-demand poll of Gmail for Netflix emails and dispatches to configured Discord channels.',
      },
      {
        type: 'api',
        name: 'Discord Webhook Configuration',
        url: '/api/config',
        method: 'POST',
        description: 'Add or remove Discord webhook destinations.',
      },
    ],
    contact: {
      name: 'Support',
      url: 'https://github.com/hoanglk12/netflix-to-discord-forwarder',
    },
  }, 200);
});

app.get('/llms.txt', (c) => {
  const content = `# Netflix to Discord Forwarder Telemetry Console

> Automated Gmail-to-Discord forwarder and real-time telemetry console for Netflix verification codes and household update confirmation links.

## Overview
This service monitors Gmail for incoming Netflix security and household management emails, extracts one-time verification access codes and one-click household confirmation links, and broadcasts formatted embeds to Discord webhook channels with zero duplicates using a 5-slot deduplication sliding window.

## Key APIs
- \`GET /api/snapshot\`: Read-only telemetry snapshot containing config, poll status, 5-slot deduplication checkpoint, and circular log ring.
- \`POST /api/poll\`: Protected on-demand forwarder run.
- \`POST /api/config\`: Webhook destination configuration.
- \`POST /api/test-webhook\`: Diagnostic Discord ping embed.
- \`POST /api/cleanup-posts\`: Prunes stale Discord embeds from earlier runs.

## Architecture & Storage
- Colocated on Vercel Singapore (\`sin1\`) with Serverless Functions.
- Upstash Redis pipeline (\`upstash-kv-violet-village\`) with distributed concurrency lock and 100-entry ring buffer.
- Vite + React 19 + Tailwind CSS v4 dashboard conforming to WCAG 2.2 AA accessibility standards.
`;
  return c.text(content, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
});

app.get('/api/snapshot', async (c) => {
  try {
    const data = await getSnapshotView();
    return c.json(data, 200);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/config', async (c) => {
  try {
    const data = await getConfigView();
    return c.json(data, 200);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/config', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { action } = body;

    let result;
    if (action === 'add') {
      result = await addWebhookUrl(body.webhookUrl?.trim());
    } else if (action === 'remove') {
      result = await removeWebhookUrl(Number(body.index));
    } else if (action === 'test') {
      result = await testWebhookByIndex(Number(body.index));
    } else {
      result = { status: 400, data: { error: 'Invalid action. Use "add", "remove", or "test".' } };
    }

    return c.json(result.data, result.status);
  } catch (error) {
    return c.json({ error: error.message }, 400);
  }
});

app.post('/api/run', async (c) => {
  try {
    const result = await runNow();
    return c.json(result.data, result.status);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

app.post('/api/delete-messages', async (c) => {
  try {
    const result = await deleteAllSentMessages();
    return c.json(result.data, result.status);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/logs', async (c) => {
  try {
    const data = await getLogsView(50);
    return c.json(data, 200);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/checkpoint', async (c) => {
  try {
    const data = await getCheckpointView();
    return c.json(data, 200);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});

app.get('/api/status', async (c) => {
  try {
    const data = await getStatusView();
    return c.json(data, 200);
  } catch (error) {
    return c.json({ error: error.message }, 500);
  }
});
