"use strict";

const { startServer } = require("./server");
const { startWorker } = require("./worker");
const { migrate } = require("./db/migrate");
const verificationQueue = require("./queue/verificationQueue");
const { pool } = require("./db/pool");
const redis = require("./redis/client");
const logger = require("./logger");

/**
 * Combined entrypoint: runs migrations, then starts the REST API and the Bull
 * verification worker together in one process (convenient for dev/single-node).
 * For horizontal scaling, run `npm run api` and `npm run worker` separately.
 */
async function main() {
  await migrate();
  const server = startServer();
  startWorker();
  logger.info("AXIS verification engine started (API + worker)");

  const shutdown = async (sig) => {
    logger.info(`Engine received ${sig}, shutting down gracefully`);
    server.close();
    await verificationQueue.close().catch(() => {});
    await pool.end().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("Fatal engine startup error", { error: err.message, stack: err.stack });
  process.exit(1);
});
