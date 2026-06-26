"use strict";

const express = require("express");
const swaggerUi = require("swagger-ui-express");
const swaggerSpec = require("./swagger");
const config = require("./config");
const { pool } = require("./db/pool");
const redis = require("./redis");
const logger = require("./logger");

const modelsRoute = require("./routes/models");
const jobsRoute = require("./routes/jobs");
const capacityRoute = require("./routes/capacity");
const priceRoute = require("./routes/price");
const reputationRoute = require("./routes/reputation");
const marketRoute = require("./routes/market");

const CORS_ALLOWED = config.corsOrigin
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/** Resolves the allowed CORS origin for a request. */
function corsOriginFor(req) {
  if (CORS_ALLOWED.includes("*")) return "*";
  const origin = req.headers.origin;
  return origin && CORS_ALLOWED.includes(origin) ? origin : CORS_ALLOWED[0] || "";
}

/**
 * Builds the marketplace Express application.
 */
function buildApp() {
  const app = express();

  // CORS — browser traders call the market endpoints cross-origin.
  app.use((req, res, next) => {
    const allow = corsOriginFor(req);
    if (allow) {
      res.setHeader("Access-Control-Allow-Origin", allow);
      if (allow !== "*") res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });

  app.use(express.json({ limit: "5mb" }));

  app.use((req, res, next) => {
    logger.debug("HTTP", { method: req.method, path: req.path });
    next();
  });

  app.get("/health", async (req, res) => {
    const health = { status: "ok", service: "axis-marketplace", time: new Date().toISOString() };
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

  // Swagger / OpenAPI docs.
  app.get("/openapi.json", (req, res) => res.json(swaggerSpec));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  app.use("/", modelsRoute);
  app.use("/", jobsRoute);
  app.use("/", capacityRoute);
  app.use("/", priceRoute);
  app.use("/", reputationRoute);
  app.use("/", marketRoute);

  app.use((req, res) => res.status(404).json({ error: "not found" }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error("Unhandled route error", { error: err.message });
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

module.exports = { buildApp };
