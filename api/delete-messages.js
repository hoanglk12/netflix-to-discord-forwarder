import { deleteAllSentMessages } from '../src/api-service.js';
import { isCrossOriginWrite } from '../src/request-guard.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (isCrossOriginWrite(req)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Cross-origin request rejected' }));
    return;
  }

  try {
    const result = await deleteAllSentMessages();
    res.statusCode = result.status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result.data));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: error.message }));
  }
}
