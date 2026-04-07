import { fetchRecentMessages } from './gmail.js';
import {
  buildCheckpointForOnceRun,
  loadCheckpoint,
  saveCheckpoint,
} from './checkpoint.js';
import { buildDiscordPayload, isRetriableDiscordError, postToDiscord } from './discord.js';
import { withRetry } from './utils.js';

function matchesSenderDomain(message, senderFilter) {
  return message.from.toLowerCase().includes(senderFilter.toLowerCase());
}

export function selectLatestMatchingMessages(messages, config) {
  return messages
    .filter((message) => matchesSenderDomain(message, config.gmailSenderFilter))
    .slice(-config.forwardLatestCount);
}

export function selectLatestMatchingMessagesForRun(messages, config, runStartedAtMs) {
  return selectLatestMatchingMessages(
    messages.filter((message) => message.internalDate <= runStartedAtMs),
    config,
  );
}

export function hasExactDuplicateWindow(currentIds, previousIds, requiredCount) {
  if (currentIds.length !== requiredCount || previousIds.length !== requiredCount) {
    return false;
  }

  return currentIds.every((id, index) => id === previousIds[index]);
}

async function sendMessages(messages, config, logger) {
  const deliveredIds = [];

  for (const message of messages) {
    const payload = buildDiscordPayload(message);
    await withRetry(
      () => postToDiscord(config.discordWebhookUrl, payload),
      {
        logger,
        taskName: 'discord webhook',
        isRetriable: isRetriableDiscordError,
      },
    );

    deliveredIds.push(message.id);
    await logger.info('Forwarded message to Discord', {
      id: message.id,
      subject: message.subject,
    });
  }

  return deliveredIds;
}

export async function runPollCycle({ gmail, config, logger }) {
  const recentMessages = await fetchRecentMessages(gmail, config, logger);
  const checkpoint = await loadCheckpoint(config.checkpointPath, config.checkpointMaxIds);
  const runStartedAtMs = Date.now();
  const latestForRun = selectLatestMatchingMessagesForRun(recentMessages, config, runStartedAtMs);
  const latestIds = latestForRun.map((message) => message.id);

  if (latestForRun.length === 0) {
    await logger.info('No matching messages found for this run', {
      senderFilter: config.gmailSenderFilter,
      latestCount: config.forwardLatestCount,
    });
    const nextCheckpoint = buildCheckpointForOnceRun(checkpoint, latestIds, config.checkpointMaxIds);
    await saveCheckpoint(config.checkpointPath, nextCheckpoint);
    return { sent: 0, skipped: 0, initialized: false };
  }

  if (hasExactDuplicateWindow(latestIds, checkpoint.lastOnceLatestIds || [], config.forwardLatestCount)) {
    await logger.info('Skipped once run because latest message window exactly matches previous once run', {
      latestCount: config.forwardLatestCount,
    });
    const nextCheckpoint = buildCheckpointForOnceRun(checkpoint, latestIds, config.checkpointMaxIds);
    await saveCheckpoint(config.checkpointPath, nextCheckpoint);
    return { sent: 0, skipped: latestForRun.length, initialized: false };
  }

  const deliveredIds = await sendMessages(latestForRun, config, logger);
  const nextCheckpoint = buildCheckpointForOnceRun(checkpoint, latestIds, config.checkpointMaxIds);
  await saveCheckpoint(config.checkpointPath, nextCheckpoint);
  return {
    sent: deliveredIds.length,
    skipped: 0,
    initialized: false,
  };
}