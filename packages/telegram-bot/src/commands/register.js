"use strict";

const { ethers } = require("ethers");
const { userStore, walletFor, gateway, CHANNEL } = require("../context");
const { b, code, plain, lines } = require("../md");
const { truncateAddress } = require("@axis/shared");
const logger = require("../logger");

/**
 * /register [wallet_address] — provisions the user's deterministic AXIS mining
 * wallet and links it to their Telegram id. An optional external address may be
 * supplied; it is validated and recorded as an informational linked reference.
 */
function register(bot) {
  bot.command("register", async (ctx) => {
    try {
      const userId = ctx.from.id;
      const parts = ctx.message.text.trim().split(/\s+/).slice(1);
      const external = parts[0];

      if (external && !ethers.isAddress(external)) {
        return ctx.replyWithMarkdownV2(
          lines(b("❌ Invalid wallet address"), plain("Provide a valid EVM address, e.g."), code("/register 0xYourAddress"))
        );
      }

      const wallet = walletFor(userId);

      // Idempotent: re-registering returns the same deterministic wallet.
      const already = await userStore.getUserWallet(CHANNEL, userId);
      await userStore.registerUser(CHANNEL, userId, wallet.address);

      let balance = "0";
      try {
        const { body } = await gateway.miner(wallet);
        balance = body.total_axis_earned ?? "0";
      } catch (_) {
        /* balance best-effort */
      }

      const msg = lines(
        b(already ? "✅ Wallet already registered" : "✅ Registration complete"),
        "",
        plain("Your AXIS mining wallet (holds all rewards):"),
        code(wallet.address),
        plain(`(${truncateAddress(wallet.address)})`),
        external ? plain(`Linked external reference: ${external}`) : null,
        "",
        plain(`Current AXIS earned: ${balance}`),
        "",
        plain("Start mining with /mine")
      );
      await ctx.replyWithMarkdownV2(msg);
    } catch (err) {
      logger.error("/register failed", { error: err.message });
      await ctx.reply("⚠️ Registration failed. Please try again.");
    }
  });
}

module.exports = { register };
