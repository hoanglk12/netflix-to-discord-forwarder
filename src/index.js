import { loadConfig } from './config.js';
import { authorizeGmail } from './gmail.js';
import { createLogger } from './logger.js';
import { runPollCycle } from './poller.js';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logFilePath);
  const gmail = await authorizeGmail(config, { allowInteractive: false });

  await logger.info('Forwarder started', {
    query: config.gmailQuery,
  });

  try {
    const result = await runPollCycle({
      gmail,
      config,
      logger,
    });
    await logger.info('Poll cycle completed', result);
  } catch (error) {
    await logger.error('Poll cycle failed', {
      message: error.message,
      stack: error.stack,
    });
    throw error;
  }

  await logger.info('Forwarder stopped');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});