"use strict";

const { Markup } = require("telegraf");
const { gateway, walletFor, isRegistered } = require("../context");
const { b, code, plain, lines } = require("../md");
const { getWorkType, isValidWorkType } = require("@axis/shared");
const config = require("../config");
const logger = require("../logger");

/**
 * Performs a submission and replies with the outcome. Shared by the /submit
 * command and the "submit sample" inline button.
 */
async function doSubmit(ctx, workType, outputData) {
  const userId = ctx.from.id;

  if (!(await isRegistered(userId))) {
    return ctx.reply("Please /register first to start mining.");
  }
  if (!isValidWorkType(workType)) {
    return ctx.replyWithMarkdownV2(
      lines(b("❌ Unknown work type"), plain("See /mine for the 7 available work types."))
    );
  }

  // Client-side cooldown (the gateway enforces the authoritative one).
  ctx.session = ctx.session || {};
  const now = Date.now();
  const last = ctx.session.lastSubmit || 0;
  const remaining = Math.ceil((config.submitCooldownSeconds * 1000 - (now - last)) / 1000);
  if (remaining > 0) {
    return ctx.replyWithMarkdownV2(
      lines(b("⏳ Cooldown active"), plain(`Please wait ${remaining}s before submitting again.`))
    );
  }

  const wallet = walletFor(userId);
  const payload = outputData && outputData.trim().length ? outputData.trim() : getWorkType(workType).sample();

  try {
    const { status, body } = await gateway.submit(wallet, workType, payload, "telegram");

    if (status === 202 || status === 200) {
      ctx.session.lastSubmit = now;
      const msg = lines(
        b("📤 Submission accepted"),
        plain(`Work type: ${workType}`),
        plain(`Job ID: ${body.job_id}`),
        plain(`Estimated processing: ~${body.estimated_processing_seconds ?? 5}s`),
        body.estimated_max_reward_axis ? plain(`Estimated max reward: ${body.estimated_max_reward_axis} AXIS`) : null,
        "",
        plain("Check progress with:"),
        code(`/status ${body.job_id}`)
      );
      return ctx.replyWithMarkdownV2(
        msg,
        Markup.inlineKeyboard([[Markup.button.callback("🔄 Check status", `status:${body.job_id}`)]])
      );
    }
    if (status === 429) {
      return ctx.replyWithMarkdownV2(
        lines(b("⏳ Rate limited"), plain(`Retry after ${body.retry_after_seconds ?? 60}s.`))
      );
    }
    return ctx.replyWithMarkdownV2(
      lines(b("❌ Submission rejected"), plain(body.error || body.reason || "unknown error"))
    );
  } catch (err) {
    logger.error("submit failed", { error: err.message });
    return ctx.reply("⚠️ Submission failed (gateway unreachable). Try again shortly.");
  }
}

function register(bot) {
  bot.command("submit", async (ctx) => {
    const text = ctx.message.text.trim();
    const firstSpace = text.indexOf(" ");
    if (firstSpace === -1) {
      return ctx.replyWithMarkdownV2(
        lines(b("Usage"), code("/submit <work_type> <output_data>"), plain("See /mine for work types."))
      );
    }
    const rest = text.slice(firstSpace + 1).trim();
    const wtSpace = rest.indexOf(" ");
    const workType = wtSpace === -1 ? rest : rest.slice(0, wtSpace);
    const outputData = wtSpace === -1 ? "" : rest.slice(wtSpace + 1);
    await doSubmit(ctx, workType, outputData);
  });

  bot.action(/^submitsample:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery("Submitting sample…");
    const wt = getWorkType(ctx.match[1]);
    if (!wt) return;
    await doSubmit(ctx, wt.id, wt.sample());
  });
}

module.exports = { register, doSubmit };
