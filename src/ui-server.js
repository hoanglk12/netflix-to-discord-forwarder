import http from 'http';
import path from 'path';
import fs from 'fs/promises';
import url from 'url';
import { fileURLToPath } from 'url';
import { loadConfig } from './config.js';
import { authorizeGmail } from './gmail.js';
import { createLogger } from './logger.js';
import { runPollCycle } from './poller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const UI_PORT = process.env.UI_PORT || 3000;

let gmail = null;
let logger = null;
let config = null;
let isRunning = false;
let lastRunResult = null;

async function initializeApp() {
  config = loadConfig();
  logger = createLogger(config.logFilePath);
  gmail = await authorizeGmail(config, { allowInteractive: false });
}

async function loadCheckpoint() {
  try {
    const content = await fs.readFile(config.checkpointPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function readLogs(lines = 20) {
  try {
    const content = await fs.readFile(config.logFilePath, 'utf8');
    return content.split('\n').slice(-lines).reverse().filter(l => l.trim());
  } catch {
    return [];
  }
}

async function updateEnvFile(key, value) {
  const envPath = path.resolve(__dirname, '../.env');
  try {
    let content = await fs.readFile(envPath, 'utf8');
    const lines = content.split('\n');
    const keyIndex = lines.findIndex(line => line.startsWith(`${key}=`));

    if (keyIndex >= 0) {
      lines[keyIndex] = `${key}=${value}`;
    } else {
      lines.push(`${key}=${value}`);
    }

    await fs.writeFile(envPath, lines.join('\n'), 'utf8');
    return true;
  } catch (error) {
    console.error(`Error updating .env: ${error.message}`);
    return false;
  }
}

async function handleApiRequest(pathname, method, body) {
  if (pathname === '/api/config' && method === 'GET') {
    return {
      status: 200,
      data: {
        gmailQuery: config.gmailQuery,
        gmailSenderFilter: config.gmailSenderFilter,
        forwardLatestCount: config.forwardLatestCount,
        gmailFetchLimit: config.gmailFetchLimit,
        discordWebhookUrl: config.discordWebhookUrl.substring(0, 50) + '...',
      },
    };
  }

  if (pathname === '/api/config' && method === 'POST') {
    try {
      const data = JSON.parse(body);
      if (data.discordWebhookUrl && data.discordWebhookUrl.trim()) {
        const success = await updateEnvFile('DISCORD_WEBHOOK_URL', data.discordWebhookUrl.trim());
        if (success) {
          config.discordWebhookUrl = data.discordWebhookUrl.trim();
          return {
            status: 200,
            data: { message: 'Discord webhook URL updated successfully' },
          };
        } else {
          return {
            status: 500,
            data: { error: 'Failed to update .env file' },
          };
        }
      } else {
        return {
          status: 400,
          data: { error: 'Invalid webhook URL' },
        };
      }
    } catch (error) {
      return {
        status: 400,
        data: { error: error.message },
      };
    }
  }

  if (pathname === '/api/run' && method === 'POST') {
    if (isRunning) {
      return { status: 409, data: { error: 'Poll already running' } };
    }

    isRunning = true;
    try {
      lastRunResult = await runPollCycle({ gmail, config, logger });
      return { status: 200, data: lastRunResult };
    } catch (error) {
      return {
        status: 500,
        data: { error: error.message },
      };
    } finally {
      isRunning = false;
    }
  }

  if (pathname === '/api/logs' && method === 'GET') {
    const logs = await readLogs(5);
    return { status: 200, data: { logs } };
  }

  if (pathname === '/api/checkpoint' && method === 'GET') {
    const checkpoint = await loadCheckpoint();
    return {
      status: 200,
      data: checkpoint || { status: 'Not initialized' },
    };
  }

  if (pathname === '/api/status' && method === 'GET') {
    return {
      status: 200,
      data: {
        isRunning,
        lastRunResult,
        gmailConfigured: !!gmail,
      },
    };
  }

  return { status: 404, data: { error: 'Not found' } };
}

async function serveFile(filePath, defaultType = 'text/html') {
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType =
      ext === '.js' ? 'application/javascript' :
      ext === '.css' ? 'text/css' :
      ext === '.json' ? 'application/json' :
      defaultType;
    return { status: 200, data, contentType };
  } catch (error) {
    return { status: 404, data: '<h1>404 Not Found</h1>', contentType: 'text/html' };
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    if (pathname === '/' || pathname === '/index.html') {
      const result = await serveFile(path.join(publicDir, 'index.html'));
      res.setHeader('Content-Type', result.contentType);
      res.writeHead(result.status);
      res.end(result.data);
      return;
    }

    if (pathname.startsWith('/api/')) {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        const result = await handleApiRequest(pathname, req.method, body);
        res.writeHead(result.status);
        res.end(JSON.stringify(result.data));
      });
      return;
    }

    // Static files
    const result = await serveFile(path.join(publicDir, pathname.substring(1)));
    res.setHeader('Content-Type', result.contentType);
    res.writeHead(result.status);
    res.end(result.data);
  } catch (error) {
    console.error(error);
    res.writeHead(500);
    res.end(JSON.stringify({ error: error.message }));
  }
});

await initializeApp();

server.listen(UI_PORT, () => {
  console.log(`UI Server running at http://localhost:${UI_PORT}`);
});
