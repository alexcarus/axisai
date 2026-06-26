"use strict";

const { gateway, walletFor } = require("../context");
const { b, code, plain, lines } = require("../md");
const logger = require("../logger");

const ICONS = { pending: "🕓", verifying: "🔬", approved: "✅", rejected: "❌", error: "⚠️" };

/**
 * Renders a job status into a MarkdownV2 message.
 */
function renderStatus(s) {
  const icon = ICONS[s.status] || "•";
  const out = [
    b(`${icon} Job ${s.status || "unknown"}`),
    plain(`Job ID: ${s.job_id}`),
    plain(`Work type: ${s.work_type}`),
  ];
  if (s.quality != null) out.push(plain(`Quality Q: ${Number(s.quality).toFixed(3)}`));
  if (s.status === "approved") {
    out.push(plain(`Reward: ${s.reward_axis} AXIS`));
    if (s.tx_hash) out.push(plain("Tx hash:"), code(s.tx_hash));
  }
  if (s.status === "rejected" && s.reject_reason) {
    out.push(plain(`Reason: ${s.reject_reason}`));
  }
  return lines(...out);
}

/**
 * /status [job_id] — query job status from the engine via the gateway.
 */
function register(bot) {
  async function handle(ctx, jobId) {
    try {
      const wallet = walletFor(ctx.from.id);
      const { status, body } = await gateway.status(wallet, jobId);
      if (status === 404) {
        return ctx.replyWithMarkdownV2(lines(b("❌ Job not found"), code(jobId)));
      }
      if (status >= 400) {
        return ctx.replyWithMarkdownV2(lines(b("⚠️ Error"), plain(body.error || "could not fetch status")));
      }
      return ctx.replyWithMarkdownV2(renderStatus(body));
    } catch (err) {
      logger.error("/status failed", { error: err.message });
      return ctx.reply("⚠️ Could not fetch status. Try again shortly.");
    }
  }

  bot.command("status", async (ctx) => {
    const parts = ctx.message.text.trim().split(/\s+/).slice(1);
    if (!parts[0]) {
      return ctx.replyWithMarkdownV2(lines(b("Usage"), code("/status <job_id>")));
    }
    await handle(ctx, parts[0]);
  });

  bot.action(/^status:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery("Fetching status…");
    await handle(ctx, ctx.match[1]);
  });
}

module.exports = { register };
