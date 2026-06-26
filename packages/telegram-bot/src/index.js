"use strict";

const { Telegraf, session } = require("telegraf");
const config = require("./config");
const logger = require("./logger");
const { userStore } = require("./context");

const commands = [
  require("./commands/start"),
  require("./commands/register"),
  require("./commands/mine"),
  require("./commands/submit"),
  require("./commands/status"),
  require("./commands/balance"),
  require("./commands/export"),
  require("./commands/epoch"),
  require("./commands/leaderboard"),
  require("./commands/network"),
  require("./commands/help"),
  require("./commands/about"),
];

if (!config.botToken) {
  logger.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const bot = new Telegraf(config.botToken);

// Session middleware for multi-step flows / cooldown tracking.
bot.use(session());

// Per-update lightweight logging.
bot.use(async (ctx, next) => {
  const t = Date.now();
  await next();
  logger.debug("update handled", {
    from: ctx.from && ctx.from.id,
    type: ctx.updateType,
    ms: Date.now() - t,
  });
});

// Register all command modules.
for (const cmd of commands) cmd.register(bot);

// Inline "Mine" button from /start.
bot.action("open_mine", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply("Use /mine to choose a work type and receive a task.");
});

// Fallback for unrecognised input -> point to /help.
bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) {
    await ctx.reply("Unknown command. Send /help for the full command list.");
  } else {
    await ctx.reply("I didn't understand that. Send /help to see what I can do.");
  }
});

// Global error handler so a single failure never crashes the bot.
bot.catch((err, ctx) => {
  logger.error("Telegraf error", { error: err.message, update: ctx.updateType });
});

async function launch() {
  if (config.webhookDomain) {
    await bot.launch({
      webhook: {
        domain: config.webhookDomain,
        path: config.webhookPath,
        port: config.webhookPort,
      },
    });
    logger.info("Telegram bot launched in WEBHOOK mode", {
      domain: config.webhookDomain,
      path: config.webhookPath,
      port: config.webhookPort,
    });
  } else {
    await bot.launch();
    logger.info("Telegram bot launched in LONG POLLING mode");
  }
}

launch().catch((err) => {
  logger.error("Bot launch failed", { error: err.message });
  process.exit(1);
});

const shutdown = async (sig) => {
  logger.info(`Telegram bot received ${sig}, shutting down`);
  bot.stop(sig);
  await userStore.close().catch(() => {});
  process.exit(0);
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
