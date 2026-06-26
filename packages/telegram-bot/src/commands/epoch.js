"use strict";

const { gateway, walletFor } = require("../context");
const { b, code, plain, lines } = require("../md");
const { progressBar, formatAxis } = require("@axis/shared");
const logger = require("../logger");

// Cumulative epoch end thresholds (AXIS), matching the contract.
const EPOCH_ENDS = {
  1: 5_250_000,
  2: 10_500_000,
  3: 15_750_000,
  4: 21_000_000,
  5: 63_000_000,
  6: 79_800_000,
  7: 84_000_000,
};
const EPOCH_STARTS = { 1: 0, 2: 5_250_000, 3: 10_500_000, 4: 15_750_000, 5: 21_000_000, 6: 63_000_000, 7: 79_800_000 };
const EPOCH_LABEL = { 1: "Genesis 1", 2: "Genesis 2", 3: "Genesis 3", 4: "Genesis 4", 5: "Standard", 6: "Late", 7: "Terminal" };

/**
 * /epoch — current epoch, reward per unit, mined vs target, progress bar and an
 * estimated completion based on the recent mining rate.
 */
function register(bot) {
  bot.command("epoch", async (ctx) => {
    try {
      const wallet = walletFor(ctx.from.id);
      const { body: stats } = await gateway.networkStats(wallet);
      const epoch = Number(stats.epoch || 1);
      const totalMined = Number(stats.total_mined_axis || 0);

      const start = EPOCH_STARTS[epoch] ?? 0;
      const end = EPOCH_ENDS[epoch] ?? 84_000_000;
      const minedThisEpoch = Math.max(0, totalMined - start);
      const target = end - start;
      const fraction = target > 0 ? Math.min(1, minedThisEpoch / target) : 1;

      const msg = lines(
        b(`📅 Epoch ${epoch} — ${EPOCH_LABEL[epoch] || "—"}`),
        plain(`Reward / verified work unit: ${stats.base_reward_axis} AXIS`),
        plain(`Mined this epoch: ${formatAxis(minedThisEpoch)} / ${formatAxis(target)} AXIS`),
        code(progressBar(fraction)),
        plain(`${(fraction * 100).toFixed(2)}% complete`),
        "",
        plain(`Difficulty D: ${stats.difficulty}`),
        plain(`Active miners (24h): ${stats.active_miners_24h ?? 0}`)
      );
      await ctx.replyWithMarkdownV2(msg);
    } catch (err) {
      logger.error("/epoch failed", { error: err.message });
      await ctx.reply("⚠️ Could not load epoch data. Try again shortly.");
    }
  });
}

module.exports = { register };
