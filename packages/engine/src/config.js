"use strict";

require("dotenv").config();

/**
 * Centralised configuration for the verification engine. Every tunable value is
 * sourced from the environment — nothing is hardcoded. Sensible local-dev
 * defaults are provided so the engine boots out of the box with docker-compose.
 */
const config = {
  env: process.env.NODE_ENV || "development",

  api: {
    port: parseInt(process.env.PORT || process.env.ENGINE_PORT || "4000", 10),
    host: process.env.ENGINE_HOST || "0.0.0.0",
  },

  // Optional shared secret. When set, every non-health request must present a
  // matching `x-internal-key` header — so only the gateway and marketplace
  // (which forward it) can reach the engine, never the public internet directly.
  internalKey: process.env.ENGINE_INTERNAL_KEY || "",

  postgres: {
    connectionString:
      process.env.DATABASE_URL ||
      "postgres://axis:axis@localhost:5432/axis",
  },

  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  chain: {
    rpcUrl: process.env.RPC_URL || "http://localhost:8545",
    chainId: parseInt(process.env.DEPLOY_CHAIN_ID || "31337", 10),
    tokenAddress: process.env.AXIS_TOKEN_ADDRESS || "",
    registryAddress: process.env.VALIDATOR_REGISTRY_ADDRESS || "",
    // Private key of a registered validator used to submit on-chain proofs.
    validatorPrivateKey: process.env.VALIDATOR_PRIVATE_KEY || "",
  },

  verification: {
    // Minimum quality (0.0-1.0) required to mint a reward.
    minQuality: parseFloat(process.env.MIN_QUALITY || "0.5"),
    // Cooldown applied to a wallet after a rejection (seconds).
    cooldownSeconds: parseInt(process.env.COOLDOWN_SECONDS || "60", 10),
    // Number of prior submissions sampled for peer cross-checking.
    peerSampleSize: parseInt(process.env.PEER_SAMPLE_SIZE || "3", 10),
    // Max submissions cached per work_type for peer sampling.
    peerCacheLimit: parseInt(process.env.PEER_CACHE_LIMIT || "500", 10),
  },

  queue: {
    name: process.env.QUEUE_NAME || "axis-verification",
    concurrency: parseInt(process.env.QUEUE_CONCURRENCY || "4", 10),
  },

  log: {
    level: process.env.LOG_LEVEL || "info",
  },
};

module.exports = config;
