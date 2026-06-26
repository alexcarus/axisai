"use strict";

const { Markup } = require("telegraf");
const { gateway, walletFor, isRegistered } = require("../context");
const { b, code, plain, lines } = require("../md");
const { WORK_TYPES, getWorkType, estimateReward, formatAxis } = require("@axis/shared");
const logger = require("../logger");

/**
 * /mine — lists the 7 work types with estimated reward and inline buttons. On
 * selection, returns the task payload + completion/submission instructions.
 */
function register(bot) {
  bot.command("mine", async (ctx) => {
    try {
      if (!(await isRegistered(ctx.from.id))) {
        return ctx.reply("Please /register first to start mining.");
      }
      const wallet = walletFor(ctx.from.id);
      const { body: stats } = await gateway.networkStats(wallet);
      const base = stats.base_reward_axis || 0;
      const difficulty = stats.difficulty || 1;

      const rows = WORK_TYPES.map((wt) => {
        const est = estimateReward(wt.id, base, difficulty);
        return [Markup.button.callback(`${wt.label} · ~${formatAxis(est)} AXIS`, `mine:${wt.id}`)];
      });

      const msg = lines(
        b("⛏️ Choose a work type to mine"),
        plain(`Current epoch reward: ${base} AXIS / verified unit · Difficulty D=${difficulty}`),
        "",
        plain("Estimated rewards assume quality Q≈1.0. Actual reward = W × Q ÷ D.")
      );
      await ctx.replyWithMarkdownV2(msg, Markup.inlineKeyboard(rows));
    } catch (err) {
      logger.error("/mine failed", { error: err.message });
      await ctx.reply("⚠️ Could not load work types. Try again shortly.");
    }
  });

  bot.action(/^mine:(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const id = ctx.match[1];
      const wt = getWorkType(id);
      if (!wt) return ctx.reply("Unknown work type.");

      const sample = wt.sample();
      const msg = lines(
        b(`${wt.label} — Task`),
        "",
        plain(wt.instructions),
        "",
        b("How to submit"),
        plain("1. Produce your output for this task."),
        plain("2. Submit it with:"),
        code(`/submit ${wt.id} <your_output_json>`),
        "",
        b("Sample output you can submit now"),
        code(`/submit ${wt.id} ${sample}`)
      );
      await ctx.replyWithMarkdownV2(
        msg,
        Markup.inlineKeyboard([[Markup.button.callback("📤 Submit sample now", `submitsample:${wt.id}`)]])
      );
    } catch (err) {
      logger.error("mine action failed", { error: err.message });
    }
  });
}

module.exports = { register };
