"use strict";

const express = require("express");
const config = require("./config");
const logger = require("./logger");
const { pool } = require("./db/pool");
const redis = require("./redis/client");

const submitRoute = require("./routes/submit");
const statusRoute = require("./routes/status");
const minerRoute = require("./routes/miner");
const networkRoute = require("./routes/network");
const scoreRoute = require("./routes/score");

/**
 * Builds the Express application exposing the verification engine REST API.
 */
function buildApp() {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  // Lightweight request log.
  app.use((req, res, next) => {
    logger.debug("HTTP", { method: req.method, path: req.path });
    next();
  });

  // Optional internal-key guard. When ENGINE_INTERNAL_KEY is set, only callers
  // presenting the matching header (the gateway / marketplace) may reach the
  // engine — closing direct public access that would bypass the gateway's
  // nonce/rate-limit/audit controls. `/health` stays open for liveness probes.
  if (config.internalKey) {
    app.use((req, res, next) => {
      if (req.path === "/health") return next();
      if (req.get("x-internal-key") === config.internalKey) return next();
      return res.status(403).json({ error: "forbidden: internal key required" });
    });
  }

  app.get("/health", async (req, res) => {
    const health = { status: "ok", service: "axis-engine", time: new Date().toISOString() };
    try {
      await pool.query("SELECT 1");
      health.postgres = "ok";
    } catch (_) {
      health.postgres = "down";
      health.status = "degraded";
    }
    try {
      await redis.ping();
      health.redis = "ok";
    } catch (_) {
      health.redis = "down";
      health.status = "degraded";
    }
    res.status(health.status === "ok" ? 200 : 503).json(health);
  });

  app.use("/", submitRoute);
  app.use("/", statusRoute);
  app.use("/", minerRoute);
  app.use("/", networkRoute);
  app.use("/", scoreRoute);

  // 404 + error handlers.
  app.use((req, res) => res.status(404).json({ error: "not found" }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error("Unhandled route error", { error: err.message });
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

/**
 * Starts the HTTP server (used when running the API standalone).
 */
function startServer() {
  const app = buildApp();
  const server = app.listen(config.api.port, config.api.host, () => {
    logger.info(`Verification engine API listening on ${config.api.host}:${config.api.port}`);
  });
  return server;
}

if (require.main === module) {
  const server = startServer();
  const shutdown = async (sig) => {
    logger.info(`API received ${sig}, shutting down`);
    server.close(async () => {
      await pool.end().catch(() => {});
      await redis.quit().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

module.exports = { buildApp, startServer };
