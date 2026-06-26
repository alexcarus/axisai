"use strict";

require("dotenv").config();

/**
 * Gateway configuration. All values environment-driven.
 */
module.exports = {
  env: process.env.NODE_ENV || "development",
  port: parseInt(process.env.GATEWAY_PORT || "3000", 10),
  host: process.env.GATEWAY_HOST || "0.0.0.0",

  // Browser miners (the web app at mpp.dev / axis.ai) call the gateway
  // cross-origin, so CORS must be allowed. Comma-separated list of allowed
  // origins, or "*" to allow any. The gateway never uses cookies, so a
  // wildcard origin is safe here.
  corsOrigin: process.env.CORS_ORIGIN || "*",

  // Upstream verification engine.
  engineUrl: process.env.ENGINE_URL || "http://localhost:4000",
  // Shared secret forwarded to the engine's internal-key guard (if enabled).
  engineInternalKey: process.env.ENGINE_INTERNAL_KEY || "",

  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  postgres: {
    connectionString: process.env.DATABASE_URL || "postgres://axis:axis@localhost:5432/axis",
  },

  // Rate limiting / DDoS protection.
  ipRatePerMinute: parseInt(process.env.IP_RATE_PER_MINUTE || "100", 10),
  walletSubmitCooldownSeconds: parseInt(process.env.WALLET_SUBMIT_COOLDOWN || "60", 10),
  banThreshold: parseInt(process.env.BAN_VIOLATION_THRESHOLD || "5", 10),
  banSeconds: parseInt(process.env.BAN_SECONDS || "900", 10),

  // Nonce + auth.
  nonceTtlSeconds: parseInt(process.env.NONCE_TTL_SECONDS || "3600", 10),
  authMaxAgeSeconds: parseInt(process.env.AUTH_MAX_AGE_SECONDS || "300", 10),

  // Anomaly detection.
  anomalyIpThreshold: parseInt(process.env.ANOMALY_IP_THRESHOLD || "3", 10),
  anomalyWindowSeconds: parseInt(process.env.ANOMALY_WINDOW_SECONDS || "3600", 10),

  logLevel: process.env.LOG_LEVEL || "info",
};
