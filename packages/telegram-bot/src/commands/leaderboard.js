"use strict";

const { gateway, walletFor } = require("../context");
const { b, plain, code, lines } = require("../md");
const { truncateAddress, formatAxis } = require("@axis/shared");
const logger = require("../logger");

/**
 * /leaderboard — top 10 miners this epoch, highlighting the caller if in top 20.
 */
function register(bot) {
  bot.command("leaderboard", async (ctx) => {
    try {
      const wallet = walletFor(ctx.from.id);
      const { body } = await gateway.leaderboard(wallet);
      const board = body.leaderboard || [];
      const me = wallet.address.toLowerCase();

      if (board.length === 0) {
        return ctx.replyWithMarkdownV2(lines(b("🏆 Leaderboard"), plain("No verified mining yet this epoch.")));
      }

      const top10 = board.slice(0, 10).map((row) => {
        const mine = row.wallet_address.toLowerCase() === me;
        const medal = row.rank === 1 ? "🥇" : row.rank === 2 ? "🥈" : row.rank === 3 ? "🥉" : `${row.rank}.`;
        const tag = mine ? " 👈 you" : "";
        return plain(`${medal} ${truncateAddress(row.wallet_address)} — ${formatAxis(row.axis_earned)} AXIS${tag}`);
      });

      const myRow = board.find((r) => r.wallet_address.toLowerCase() === me);
      const footer =
        myRow && myRow.rank > 10
          ? plain(`Your position: #${myRow.rank} — ${formatAxis(myRow.axis_earned)} AXIS`)
          : !myRow
          ? plain("You are not on the board yet — start mining with /mine")
          : null;

      await ctx.replyWithMarkdownV2(
        lines(b(`🏆 Top miners — Epoch ${body.epoch ?? "—"}`), "", ...top10, footer ? "" : null, footer)
      );
    } catch (err) {
      logger.error("/leaderboard failed", { error: err.message });
      await ctx.reply("⚠️ Could not load leaderboard. Try again shortly.");
    }
  });
}

module.exports = { register };
