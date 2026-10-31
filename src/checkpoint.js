import fs from 'node:fs/promises';
import path from 'node:path';

export const CHECKPOINT_REDIS_KEY = 'netflix-forwarder:checkpoint-state';
const CHECKPOINT_CACHE_TTL_MS = 10000;

let inMemoryCheckpoint = null;
let inMemoryCheckpointAt = 0;

function getLocalDayKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimestamp(date = new Date()) {
  return date.toISOString();
}

export function createEmptyState(dayKey = getLocalDayKey()) {
  return {
    version: 2,
    day: dayKey,
    sentCount: 0,
    sentIds: [],
    lastOnceLatestIds: [],
    lastOnceRunAt: null,
    lastSuccessAt: null,
    lastSentDiscordMessages: [],
    windowMessages: [],
    lastOutcome: null,
  };
}

function sanitizeWindowMessage(item) {
  if (!item || typeof item !== 'object' || !item.id) return null;
  return {
    id: String(item.id),
    subject: String(item.subject || '(no subject)'),
    from: String(item.from || '(unknown sender)'),
    internalDate: Number.isFinite(Number(item.internalDate)) ? Number(item.internalDate) : null,
    snippet: String(item.snippet || '').slice(0, 300),
    category: String(item.category || 'general'),
    extractedCode: item.extractedCode ? String(item.extractedCode) : null,
    ctaUrl: item.ctaUrl ? String(item.ctaUrl) : null,
    ctaLabel: item.ctaLabel ? String(item.ctaLabel) : null,
    permalink: item.permalink ? String(item.permalink) : `https://mail.google.com/mail/u/0/#inbox/${item.id}`,
  };
}

export function normalizeState(raw, maxIds = 250, dayKey = getLocalDayKey()) {
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
    windowMessages: Array.isArray(raw.windowMessages)
      ? raw.windowMessages.map(sanitizeWindowMessage).filter(Boolean)
      : [],
    lastOutcome: ['posted', 'skipped', 'nothing'].includes(raw.lastOutcome) ? raw.lastOutcome : null,
  };

  if (normalized.day !== dayKey) {
    return {
      ...createEmptyState(dayKey),
      lastOnceLatestIds: [...new Set(normalized.lastOnceLatestIds)].slice(-maxIds),
      lastOnceRunAt: normalized.lastOnceRunAt,
      lastSuccessAt: normalized.lastSuccessAt,
      lastSentDiscordMessages: normalized.lastSentDiscordMessages,
      windowMessages: normalized.windowMessages,
      lastOutcome: normalized.lastOutcome,
    };
  }

  normalized.sentIds = [...new Set(normalized.sentIds)].slice(-maxIds);
  normalized.lastOnceLatestIds = [...new Set(normalized.lastOnceLatestIds)].slice(-maxIds);
  normalized.sentCount = Math.min(normalized.sentCount, normalized.sentIds.length || normalized.sentCount);
  return normalized;
}

export function getRedisCredentials() {
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
  } catch (error) {
    console.error('Failed to load checkpoint from Redis', error);
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
  } catch (error) {
    console.error('Failed to save checkpoint to Redis', error);
  }
}

export function setCheckpointCache(rawState) {
  inMemoryCheckpoint = rawState;
  inMemoryCheckpointAt = Date.now();
}

export async function loadCheckpoint(filePath, maxIds) {
  const dayKey = getLocalDayKey();

  if (process.env.VERCEL) {
    const isStale = !inMemoryCheckpoint || Date.now() - inMemoryCheckpointAt >= CHECKPOINT_CACHE_TTL_MS;
    if (isStale) {
      const redisState = await loadRedisCheckpoint();
      inMemoryCheckpoint = redisState || createEmptyState(dayKey);
      inMemoryCheckpointAt = Date.now();
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
    inMemoryCheckpointAt = Date.now();
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

function extractWebhookId(webhookUrl) {
  if (typeof webhookUrl !== 'string') return null;
  try {
    const match = new URL(webhookUrl).pathname.match(/\/webhooks\/(\d+)(?:\/|$)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function toPublicCheckpoint(state, webhookUrls = []) {
  if (!state || typeof state !== 'object' || !('lastSentDiscordMessages' in state)) {
    return state;
  }

  const entries = Array.isArray(state.lastSentDiscordMessages) ? state.lastSentDiscordMessages : [];
  return {
    ...state,
    lastSentDiscordMessages: entries.map((entry) => {
      const webhookIndex = webhookUrls.indexOf(entry?.webhookUrl);
      return {
        messageId: entry?.messageId ?? null,
        webhookId: extractWebhookId(entry?.webhookUrl),
        webhookIndex: webhookIndex >= 0 ? webhookIndex : null,
      };
    }),
  };
}

export function buildCheckpointForOnceRun(
  currentState,
  latestIds,
  maxIds,
  discordMessages = [],
  options = {},
) {
  const dayKey = getLocalDayKey();
  const baseState = currentState.day === dayKey ? currentState : createEmptyState(dayKey);
  const windowMessages = Array.isArray(options.windowMessages)
    ? options.windowMessages.map(sanitizeWindowMessage).filter(Boolean)
    : (baseState.windowMessages || []);
  const deliveredIds = Array.isArray(options.deliveredIds) ? options.deliveredIds : [];
  const mergedSentIds = [...new Set([...(baseState.sentIds || []), ...deliveredIds])].slice(-maxIds);
  const outcome = options.outcome || baseState.lastOutcome || null;
  const nowIso = formatTimestamp();

  return {
    version: 2,
    day: baseState.day,
    sentCount: mergedSentIds.length || baseState.sentCount,
    sentIds: mergedSentIds,
    lastOnceLatestIds: [...new Set(latestIds)].slice(-maxIds),
    lastOnceRunAt: nowIso,
    lastSuccessAt: deliveredIds.length > 0 ? nowIso : baseState.lastSuccessAt,
    lastSentDiscordMessages: discordMessages,
    windowMessages,
    lastOutcome: outcome,
  };
}
