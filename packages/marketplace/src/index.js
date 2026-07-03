"use strict";

const { buildApp } = require("./app");
const { migrate } = require("./db/migrate");
const pricing = require("./services/pricing");
const { startWorkers } = require("./queue/workers");
const { matchQueue, timeoutQueue } = require("./queue");
const { pool } = require("./db/pool");
const redis = require("./redis");
const config = require("./config");
const logger = require("./logger");
const { assertProductionSecurity } = require("./security");

/**
 * Marketplace entrypoint: migrate, start the API, the pricing engine and the
 * Bull workers (matching + timeouts).
 */
async function main() {
  assertProductionSecurity();
  await migrate();

  const app = buildApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info(`Marketplace API listening on ${config.host}:${config.port} (docs at /docs)`);
  });

  pricing.start();
  startWorkers();

  const shutdown = async (sig) => {
    logger.info(`Marketplace received ${sig}, shutting down gracefully`);
    pricing.stop();
    server.close();
    await matchQueue.close().catch(() => {});
    await timeoutQueue.close().catch(() => {});
    await pool.end().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("Fatal marketplace startup error", { error: err.message, stack: err.stack });
  process.exit(1);
});
