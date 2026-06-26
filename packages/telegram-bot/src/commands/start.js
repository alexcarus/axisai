"use strict";

const { Markup } = require("telegraf");
const { gateway, walletFor } = require("../context");
const { b, i, code, plain, lines } = require("../md");
const { progressBar, formatAxis } = require("@axis/shared");
const logger = require("../logger");

const GENESIS_SUPPLY = 21_000_000;

/**
 * /start — welcome + live Genesis Phase stats + progress bar + register prompt.
 */
function register(bot) {
  bot.start(async (ctx) => {
    try {
      const wallet = walletFor(ctx.from.id);
      const { body: stats } = await gateway.networkStats(wallet);

      const totalMined = Number(stats.total_mined_axis || 0);
      const epoch = stats.epoch ?? "—";
      const baseReward = stats.base_reward_axis ?? "—";
      const genesisFraction = Math.min(1, totalMined / GENESIS_SUPPLY);
      const genesisPct = (genesisFraction * 100).toFixed(2);

      const msg = lines(
        b("⚡ Welcome to AXIS AI — Proof-of-AI-Work Mining"),
        "",
        plain("AXIS turns AI computation into a mineable digital commodity. Fixed supply of 84,000,000 AXIS — no premine, no admin keys. Mine it. Own it. Trade it."),
        "",
        b("🌱 Genesis Phase (first 25% of supply)"),
        plain(`Epoch: ${epoch}`),
        plain(`Reward / verified work unit: ${baseReward} AXIS`),
        plain(`Total mined: ${formatAxis(totalMined)} / 21,000,000 AXIS`),
        plain(`Genesis complete: ${genesisPct}%`),
        code(progressBar(genesisFraction)),
        "",
        plain("Register your wallet to begin mining:"),
        code("/register")
      );

      await ctx.replyWithMarkdownV2(
        msg,
        Markup.inlineKeyboard([
          [Markup.button.callback("🪪 Register", "do_register")],
          [Markup.button.callback("⛏️ Mine", "open_mine"), Markup.button.callback("ℹ️ About", "open_about")],
        ])
      );
    } catch (err) {
      logger.error("/start failed", { error: err.message });
      await ctx.reply("⚠️ Could not load network stats. Please try again shortly.");
    }
  });

  bot.action("do_register", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Send /register to provision your AXIS mining wallet.");
  });
}

module.exports = { register };
