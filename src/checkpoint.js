import fs from 'node:fs/promises';
import path from 'node:path';

function getLocalDayKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
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
  };

  if (normalized.day !== dayKey) {
    return {
      ...createEmptyState(dayKey),
      lastOnceLatestIds: [...new Set(normalized.lastOnceLatestIds)].slice(-maxIds),
      lastOnceRunAt: normalized.lastOnceRunAt,
    };
  }

  normalized.sentIds = [...new Set(normalized.sentIds)].slice(-maxIds);
  normalized.lastOnceLatestIds = [...new Set(normalized.lastOnceLatestIds)].slice(-maxIds);
  normalized.sentCount = Math.min(normalized.sentCount, normalized.sentIds.length || normalized.sentCount);
  return normalized;
}

export async function loadCheckpoint(filePath, maxIds) {
  const dayKey = getLocalDayKey();

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

export function buildCheckpointForOnceRun(currentState, latestIds, maxIds) {
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
  };
}