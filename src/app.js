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
