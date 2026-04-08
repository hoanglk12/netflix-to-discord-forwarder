import { getConfigView, addWebhookUrl, removeWebhookUrl } from '../src/api-service.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const data = await getConfigView();
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
      return;
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const { action } = body;

      let result;
      if (action === 'add') {
        result = await addWebhookUrl(body.webhookUrl?.trim());
      } else if (action === 'remove') {
        result = await removeWebhookUrl(Number(body.index));
      } else {
        result = { status: 400, data: { error: 'Invalid action. Use "add" or "remove".' } };
      }

      res.statusCode = result.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result.data));
      return;
    } catch (error) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: error.message }));
      return;
    }
  }

  res.statusCode = 405;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}
