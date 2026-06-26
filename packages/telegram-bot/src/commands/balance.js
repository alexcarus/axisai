"use strict";

const { gateway, walletFor, isRegistered } = require("../context");
const { b, code, plain, lines } = require("../md");
const { formatAxis, formatPercent } = require("@axis/shared");
const logger = require("../logger");

/**
 * /balance — total AXIS earned, submissions this epoch, verification rate.
 */
function register(bot) {
  bot.command("balance", async (ctx) => {
    try {
      if (!(await isRegistered(ctx.from.id))) {
        return ctx.reply("Please /register first.");
      }
      const wallet = walletFor(ctx.from.id);
      const { body } = await gateway.miner(wallet);

      const msg = lines(
        b("💰 Your AXIS Balance"),
        code(wallet.address),
        "",
        plain(`Total AXIS earned: ${formatAxis(body.total_axis_earned)} AXIS`),
        body.on_chain_balance_axis != null ? plain(`On-chain balance: ${formatAxis(body.on_chain_balance_axis)} AXIS`) : null,
        plain(`Submissions: ${body.total_submitted ?? 0}`),
        plain(`Verified: ${body.total_verified ?? 0}`),
        plain(`Verification rate: ${formatPercent((body.verification_rate || 0) * 100)}`),
        body.on_cooldown ? plain(`⏳ Cooldown: ${body.cooldown_seconds_remaining}s`) : null
      );
      await ctx.replyWithMarkdownV2(msg);
    } catch (err) {
      logger.error("/balance failed", { error: err.message });
      await ctx.reply("⚠️ Could not fetch balance. Try again shortly.");
    }
  });
}

module.exports = { register };
