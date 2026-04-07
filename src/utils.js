export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry(task, options = {}) {
  const {
    retries = 4,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    logger,
    isRetriable = () => false,
    taskName = 'operation',
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt > retries || !isRetriable(error)) {
        throw error;
      }

      const retryAfterMs = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : null;
      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.round(Math.random() * 250);
      const delayMs = retryAfterMs ?? exponentialDelay + jitter;

      if (logger) {
        await logger.warn(`${taskName} failed, retrying`, {
          attempt,
          delayMs,
          error: error.message,
        });
      }

      await sleep(delayMs);
    }
  }

  throw lastError;
}

export function truncate(value, maxLength) {
  if (!value) {
    return '';
  }

  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function chunkText(value) {
  return value.replace(/\s+/g, ' ').trim();
}