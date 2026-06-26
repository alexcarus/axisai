"use strict";

require("dotenv").config();

module.exports = {
  env: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || process.env.MARKETPLACE_PORT || "5000", 10),
  host: process.env.MARKETPLACE_HOST || "0.0.0.0",

  // Browser traders call the market endpoints cross-origin, so CORS must be
  // allowed. Comma-separated origins, or "*" for any.
  corsOrigin: process.env.CORS_ORIGIN || "*",

  // AXIS Market — AI-quoted trading with a liquidity↔miner fee split.
  market: {
    basePrice: parseFloat(process.env.MARKET_BASE_PRICE || "2.41"),
    feeRate: parseFloat(process.env.MARKET_FEE_RATE || "0.005"),
    lpShare: parseFloat(process.env.MARKET_LP_SHARE || "0.6"),
    minerShare: parseFloat(process.env.MARKET_MINER_SHARE || "0.4"),
    baseSpread: parseFloat(process.env.MARKET_BASE_SPREAD || "0.008"),
    aiSpread: parseFloat(process.env.MARKET_AI_SPREAD || "0.002"),
    quoteTtlSeconds: parseInt(process.env.MARKET_QUOTE_TTL || "30", 10),
    // Account credited the AI fee when an order does not name a miner wallet.
    minerWallet:
      process.env.MARKET_MINER_WALLET ||
      process.env.VALIDATOR_REGISTRY_ADDRESS ||
      "axis-ai-miner-pool",
  },

  postgres: {
    connectionString: process.env.DATABASE_URL || "postgres://axis:axis@localhost:5432/axis",
  },
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  // Upstream PoAIW engine used for scoring compute-job deliveries.
  engineUrl: process.env.ENGINE_URL || "http://localhost:4000",
  // Shared secret forwarded to the engine's internal-key guard (if enabled).
  engineInternalKey: process.env.ENGINE_INTERNAL_KEY || "",

  chain: {
    rpcUrl: process.env.RPC_URL || "http://localhost:8545",
    tokenAddress: process.env.AXIS_TOKEN_ADDRESS || "",
    escrowAddress: process.env.MARKETPLACE_ESCROW_ADDRESS || "",
    registryAddress: process.env.VALIDATOR_REGISTRY_ADDRESS || "",
    // Validator-authorised operator key for on-chain escrow settlement.
    operatorPrivateKey: process.env.MARKETPLACE_PRIVATE_KEY || "",
    // When true, mirror escrow/capacity settlement on-chain (requires the
    // requester to have locked funds in the escrow contract first).
    onchain: String(process.env.ESCROW_ONCHAIN || "false") === "true",
  },

  pricing: {
    basePrice: parseFloat(process.env.PRICING_BASE_PRICE || "1.0"),
    intervalMs: parseInt(process.env.PRICING_INTERVAL_MS || "60000", 10),
  },

  jobs: {
    timeoutSeconds: parseInt(process.env.JOB_TIMEOUT_SECONDS || "1800", 10), // 30 min
    minQuality: parseFloat(process.env.JOB_MIN_QUALITY || "0.5"),
  },

  logLevel: process.env.LOG_LEVEL || "info",
};
