"use strict";

const { b, code, plain, lines } = require("../md");

/**
 * /about — full AXIS protocol description, supply info, Genesis explanation and
 * how to start mining.
 */
function register(bot) {
  const text = lines(
    b("ℹ️ About AXIS AI"),
    "",
    plain("AXIS AI is a decentralized Proof-of-AI-Work (PoAIW) protocol that turns AI computation into a mineable digital commodity. You earn AXIS by contributing verifiable AI work — inference, training steps, dataset labeling, synthetic data and peer validation."),
    "",
    b("Supply"),
    plain("Total: 84,000,000 AXIS — fixed forever. No premine, no founder allocation, no treasury, no admin keys. 100% distributed through mining."),
    "",
    b("Genesis Phase (first 25% = 21,000,000 AXIS)"),
    plain("Epoch 1: 200 AXIS/unit (→ 5,250,000)"),
    plain("Epoch 2: 100 AXIS/unit (→ 10,500,000)"),
    plain("Epoch 3: 50 AXIS/unit (→ 15,750,000)"),
    plain("Epoch 4: 25 AXIS/unit (→ 21,000,000)"),
    "",
    b("Reward formula"),
    code("AXIS Reward = W × Q ÷ D"),
    plain("W = workload units · Q = quality (0–1) · D = difficulty"),
    "",
    b("Start mining"),
    plain("1. /register  2. /mine  3. /submit  4. /status")
  );

  bot.command("about", (ctx) => ctx.replyWithMarkdownV2(text));
  bot.action("open_about", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.replyWithMarkdownV2(text);
  });
}

module.exports = { register };
