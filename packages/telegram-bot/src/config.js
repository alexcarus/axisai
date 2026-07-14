"use strict";

require("dotenv").config();

module.exports = {
  botToken: process.env.TELEGRAM_BOT_TOKEN || "",
  // If set, the bot runs in webhook mode; otherwise it uses long polling.
  webhookDomain: process.env.TELEGRAM_WEBHOOK_DOMAIN || "",
  webhookPath: process.env.TELEGRAM_WEBHOOK_PATH || "/telegram/webhook",
  webhookPort: parseInt(process.env.TELEGRAM_WEBHOOK_PORT || "8080", 10),

  gatewayUrl: process.env.GATEWAY_URL || "http://localhost:3000",
  rpcUrl: process.env.RPC_URL || "http://localhost:8545",
  databaseUrl: process.env.DATABASE_URL || "postgres://axis:axis@localhost:5432/axis",

  // The AXIS website's web miner. `/export` links here with ?import=1 so the
  // import panel opens ready for the user to paste their exported key.
  webMinerUrl: process.env.WEB_MINER_URL || "https://axis.ai/?import=1",

  // The AXIS web Mini App (wallet + miner), opened as a Telegram Web App from
  // the bot's menu button and the /start "Open App" button.
  miniAppUrl: process.env.MINI_APP_URL || "https://axismyai.com/wallet",

  signerSecret: process.env.BOT_SIGNER_SECRET || "axis-dev-signer-secret-change-me",
  submitCooldownSeconds: parseInt(process.env.SUBMIT_COOLDOWN_SECONDS || "60", 10),

  logLevel: process.env.LOG_LEVEL || "info",
};
