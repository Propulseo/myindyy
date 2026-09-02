import { fileURLToPath } from 'node:url';
import { healthcheckOptionsFromEnvironment, probeReady } from './healthcheck.js';

async function main(): Promise<void> {
  await probeReady(healthcheckOptionsFromEnvironment());
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
