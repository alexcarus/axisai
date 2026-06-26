"use strict";

require("dotenv").config();

module.exports = {
  port: parseInt(process.env.WHATSAPP_PORT || "8090", 10),
  host: process.env.WHATSAPP_HOST || "0.0.0.0",

  // Meta WhatsApp Business Cloud API
  graphVersion: process.env.GRAPH_API_VERSION || "v19.0",
  accessToken: process.env.META_ACCESS_TOKEN || "",
  phoneNumberId: process.env.META_PHONE_NUMBER_ID || "",
  appSecret: process.env.META_APP_SECRET || "",
  appId: process.env.META_APP_ID || "",
  verifyToken: process.env.META_VERIFY_TOKEN || "axis-verify-token",

  gatewayUrl: process.env.GATEWAY_URL || "http://localhost:3000",
  rpcUrl: process.env.RPC_URL || "http://localhost:8545",
  databaseUrl: process.env.DATABASE_URL || "postgres://axis:axis@localhost:5432/axis",

  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379", 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  signerSecret: process.env.BOT_SIGNER_SECRET || "axis-dev-signer-secret-change-me",
  submitCooldownSeconds: parseInt(process.env.SUBMIT_COOLDOWN_SECONDS || "60", 10),

  logLevel: process.env.LOG_LEVEL || "info",
};
