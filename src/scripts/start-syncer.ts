import { loadConfig } from "../config";
import { newLogger } from "../log";
import { Syncer } from "../syncer";

/**
 * Run the Syncer continuously.
 */
async function run() {
  const config = loadConfig();
  const logger = newLogger(config.logLevel);
  const syncIntervalMs = (config.syncInterval || 30) * 1000;
  const syncer = new Syncer(config);

  while (true) {
    const start = new Date();

    await syncer.run();

    const end = new Date();
    // @ts-expect-error this is a valid subtraction
    const timeToSleep = syncIntervalMs - (end - start);
    if (timeToSleep < 0) {
      continue;
    }

    // A small hack since there is no native sleep function in Node.js
    await new Promise((resolve) => {
      logger.info(`Sleeping for ${Math.floor(timeToSleep / 1000)} seconds...`);
      setTimeout(resolve, timeToSleep);
    });
  }
}

run();
