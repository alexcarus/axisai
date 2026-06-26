"use strict";

const { walletFor, isRegistered } = require("../context");
const { b, code, plain, lines, link } = require("../md");
const { truncateAddress } = require("@axis/shared");
const config = require("../config");
const logger = require("../logger");

/**
 * /export — reveals the user's mining private key so they can import it into
 * the web miner (on the AXIS site) or the terminal miner and mine to the SAME
 * wallet everywhere, accruing every reward into one balance.
 *
 * The AXIS messaging wallet is non-custodial by design (whitepaper §8): it is
 * deterministically derived and fully exportable, so the user — not the bot —
 * is the true owner. We delete the triggering message and surround the key with
 * explicit warnings.
 */
function register(bot) {
  bot.command("export", async (ctx) => {
    try {
      if (!(await isRegistered(ctx.from.id))) {
        return ctx.reply("Please /register first to provision your wallet.");
      }

      // Best-effort: remove the user's "/export" message so the request itself
      // isn't left sitting in a shared chat's history.
      try {
        await ctx.deleteMessage();
      } catch (_) {
        /* not deletable (e.g. older than 48h / no rights) */
      }

      const wallet = walletFor(ctx.from.id);

      const msg = lines(
        b("🔑 Export your AXIS mining wallet"),
        "",
        plain("Mining address (holds all your rewards):"),
        code(wallet.address),
        plain(`(${truncateAddress(wallet.address)})`),
        "",
        plain("Private key — import this to mine to the SAME wallet on the web or in your terminal:"),
        code(wallet.privateKey),
        "",
        link("▶ Open the AXIS web miner", config.webMinerUrl),
        plain('On the web miner, tap "import", paste the key above, and Telegram, web and terminal mining all land in one balance.'),
        plain("Terminal:"),
        code("node bin/axis-miner.mjs --key <your_key>"),
        "",
        b("⚠ Never share this key with anyone."),
        plain("Whoever holds it controls your AXIS. AXIS will never ask you for it.")
      );

      await ctx.replyWithMarkdownV2(msg);
    } catch (err) {
      logger.error("/export failed", { error: err.message });
      await ctx.reply("⚠️ Could not export your wallet. Try again shortly.");
    }
  });

  // Inline "Export to web" affordance.
  bot.action("do_export", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Send /export to reveal your mining key and import it into the web or terminal miner.");
  });
}

module.exports = { register };
