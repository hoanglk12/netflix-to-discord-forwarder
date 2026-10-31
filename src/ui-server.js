import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { app } from './app.js';
import { isLoopbackHost } from './request-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');
const publicDir = path.resolve(__dirname, '../public');
const UI_PORT = Number(process.env.UI_PORT) || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Enforce loopback host check for local /api/* calls
app.use('/api/*', async (c, next) => {
  const host = c.req.header('host');
  if (!isLoopbackHost(host)) {
    return c.json({ error: 'Host not allowed' }, 403);
  }
  return next();
});

async function tryReadStaticFile(relativePath) {
  const cleanRel = relativePath.replace(/^\/+/, '') || 'index.html';

  for (const baseDir of [distDir, publicDir]) {
    const resolved = path.resolve(baseDir, cleanRel);
    if (!resolved.startsWith(baseDir)) continue;
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile()) {
        const content = await fs.readFile(resolved);
        const ext = path.extname(resolved).toLowerCase();
        return {
          content,
          contentType: MIME_TYPES[ext] || 'application/octet-stream',
        };
      }
    } catch {
      // Try next directory
    }
  }
  return null;
}

app.get('*', async (c) => {
  const reqPath = c.req.path === '/' ? '/index.html' : c.req.path;
  const found = await tryReadStaticFile(reqPath);
  if (found) {
    return new Response(found.content, {
      status: 200,
      headers: { 'Content-Type': found.contentType },
    });
  }

  // SPA fallback to index.html
  const indexFile = await tryReadStaticFile('index.html');
  if (indexFile) {
    return new Response(indexFile.content, {
      status: 200,
      headers: { 'Content-Type': indexFile.contentType },
    });
  }

  return c.text('404 Not Found', 404);
});

serve({
  fetch: app.fetch,
  port: UI_PORT,
}, (info) => {
  console.log(`Unified Hono UI Server running at http://localhost:${info.port}`);
});
