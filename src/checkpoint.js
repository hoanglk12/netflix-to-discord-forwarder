import fs from 'node:fs/promises';
import path from 'node:path';

const CHECKPOINT_REDIS_KEY = 'netflix-forwarder:checkpoint-state';

let inMemoryCheckpoint = null;

function getLocalDayKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimestamp(date = new Date()) {
  return date.toISOString();
}

function createEmptyState(dayKey) {
  return {
    version: 2,
    day: dayKey,
    sentCount: 0,
    sentIds: [],
    lastOnceLatestIds: [],
    lastOnceRunAt: null,
    lastSuccessAt: null,
    lastSentDiscordMessages: [],
  };
}

function normalizeState(raw, maxIds, dayKey) {
  if (raw?.version !== 2) {
    return createEmptyState(dayKey);
  }

  const normalized = {
    version: 2,
    day: raw.day || dayKey,
    sentCount: Number.isFinite(raw.sentCount) ? Math.max(0, raw.sentCount) : 0,
    sentIds: Array.isArray(raw.sentIds) ? raw.sentIds.filter(Boolean) : [],
    lastOnceLatestIds: Array.isArray(raw.lastOnceLatestIds) ? raw.lastOnceLatestIds.filter(Boolean) : [],
    lastOnceRunAt: raw.lastOnceRunAt || null,
    lastSuccessAt: raw.lastSuccessAt || null,
    lastSentDiscordMessages: Array.isArray(raw.lastSentDiscordMessages) ? raw.lastSentDiscordMessages : [],
  };

  if (normalized.day !== dayKey) {
    return {
      ...createEmptyState(dayKey),
      lastOnceLatestIds: [...new Set(normalized.lastOnceLatestIds)].slice(-maxIds),
      lastOnceRunAt: normalized.lastOnceRunAt,
      lastSentDiscordMessages: normalized.lastSentDiscordMessages,
    };
  }

  normalized.sentIds = [...new Set(normalized.sentIds)].slice(-maxIds);
  normalized.lastOnceLatestIds = [...new Set(normalized.lastOnceLatestIds)].slice(-maxIds);
  normalized.sentCount = Math.min(normalized.sentCount, normalized.sentIds.length || normalized.sentCount);
  return normalized;
}

// The Vercel<->Upstash connection sometimes provisions the older "Vercel KV"
// env var names (KV_REST_API_URL/TOKEN) instead of UPSTASH_REDIS_REST_URL/TOKEN,
// depending on how the integration was added. Accept either.
function getRedisCredentials() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

async function loadRedisCheckpoint() {
  const credentials = getRedisCredentials();
  if (!credentials) return null;

  try {
    const { Redis } = await import('@upstash/redis');
    const redis = new Redis(credentials);
    return await redis.get(CHECKPOINT_REDIS_KEY);
  } catch {
    return null;
  }
}

async function saveRedisCheckpoint(state) {
  const credentials = getRedisCredentials();
  if (!credentials) return;

  try {
    const { Redis } = await import('@upstash/redis');
    const redis = new Redis(credentials);
    await redis.set(CHECKPOINT_REDIS_KEY, state);
  } catch {
    // Best-effort: keep the in-memory copy even if the Redis write fails.
  }
}

export async function loadCheckpoint(filePath, maxIds) {
  const dayKey = getLocalDayKey();

  if (process.env.VERCEL) {
    // Hydrate from Redis at most once per warm instance so that state (e.g.
    // lastSentDiscordMessages) survives cold starts across separate
    // /api/run and /api/delete-messages invocations, without issuing a
    // Redis command on every 5s dashboard poll of this same instance.
    if (!inMemoryCheckpoint) {
      const redisState = await loadRedisCheckpoint();
      inMemoryCheckpoint = redisState || createEmptyState(dayKey);
    }
    return normalizeState(inMemoryCheckpoint, maxIds, dayKey);
  }

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return normalizeState(JSON.parse(raw), maxIds, dayKey);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return createEmptyState(dayKey);
    }
    throw error;
  }
}

export async function saveCheckpoint(filePath, state) {
  if (process.env.VERCEL) {
    inMemoryCheckpoint = state;
    await saveRedisCheckpoint(state);
    return;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
}

export function buildUpdatedCheckpoint(currentState, deliveredIds, maxIds) {
  const dayKey = getLocalDayKey();
  const baseState = currentState.day === dayKey ? currentState : createEmptyState(dayKey);
  const mergedIds = [...baseState.sentIds, ...deliveredIds];
  const sentIds = [...new Set(mergedIds)].slice(-maxIds);

  return {
    version: 2,
    day: dayKey,
    sentCount: sentIds.length,
    sentIds,
    lastOnceLatestIds: baseState.lastOnceLatestIds || [],
    lastOnceRunAt: baseState.lastOnceRunAt || null,
    lastSuccessAt: formatTimestamp(),
  };
}

export function buildCheckpointForOnceRun(currentState, latestIds, maxIds, discordMessages = []) {
  const dayKey = getLocalDayKey();
  const baseState = currentState.day === dayKey ? currentState : createEmptyState(dayKey);

  return {
    version: 2,
    day: baseState.day,
    sentCount: baseState.sentCount,
    sentIds: baseState.sentIds,
    lastOnceLatestIds: [...new Set(latestIds)].slice(-maxIds),
    lastOnceRunAt: formatTimestamp(),
    lastSuccessAt: baseState.lastSuccessAt,
    lastSentDiscordMessages: discordMessages,
  };
}