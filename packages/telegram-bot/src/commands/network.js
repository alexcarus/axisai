"use strict";

const { gateway, walletFor } = require("../context");
const { b, plain, lines } = require("../md");
const { formatAxis, formatPercent } = require("@axis/shared");
const logger = require("../logger");

/**
 * /network — live network stats: difficulty D, active miners, total mined and
 * percentage of total supply.
 */
function register(bot) {
  bot.command("network", async (ctx) => {
    try {
      const wallet = walletFor(ctx.from.id);
      const { body } = await gateway.networkStats(wallet);

      const msg = lines(
        b("🌐 AXIS Network"),
        plain(`Difficulty D: ${body.difficulty}`),
        plain(`Current epoch: ${body.epoch}`),
        plain(`Reward / unit: ${body.base_reward_axis} AXIS`),
        plain(`Total mined: ${formatAxis(body.total_mined_axis)} / ${formatAxis(body.max_supply_axis)} AXIS`),
        plain(`Supply mined: ${formatPercent(body.percent_of_supply_mined || 0)}`),
        plain(`Active miners (24h): ${body.active_miners_24h ?? 0}`)
      );
      await ctx.replyWithMarkdownV2(msg);
    } catch (err) {
      logger.error("/network failed", { error: err.message });
      await ctx.reply("⚠️ Could not load network stats. Try again shortly.");
    }
  });
}

module.exports = { register };
