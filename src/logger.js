import fs from 'node:fs/promises';
import path from 'node:path';

function timestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

export function createLogger(logFilePath) {
  let initialized = false;

  async function ensureLogDir() {
    if (initialized) {
      return;
    }

    await fs.mkdir(path.dirname(logFilePath), { recursive: true });
    initialized = true;
  }

  async function write(level, message, details) {
    const line = `${timestamp()} ${level.toUpperCase()} ${message}${details ? ` ${JSON.stringify(details)}` : ''}`;
    if (level === 'error') {
      console.error(line);
    } else {
      console.log(line);
    }

    await ensureLogDir();
    await fs.appendFile(logFilePath, `${line}\n`, 'utf8');
  }

  return {
    info(message, details) {
      return write('info', message, details);
    },
    warn(message, details) {
      return write('warn', message, details);
    },
    error(message, details) {
      return write('error', message, details);
    },
  };
}