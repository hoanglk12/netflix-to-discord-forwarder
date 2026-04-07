import { loadConfig } from './config.js';
import { authorizeGmail } from './gmail.js';

async function main() {
  const config = loadConfig();
  await authorizeGmail(config, { allowInteractive: true });
  console.log(`Saved Gmail OAuth token to ${config.gmailTokenPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});