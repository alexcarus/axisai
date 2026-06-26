"use strict";

const { b, code, plain, lines } = require("../md");

/**
 * /help — full formatted command list.
 */
function register(bot) {
  const text = lines(
    b("⚡ AXIS AI — Commands"),
    "",
    plain("/start — welcome + live Genesis stats"),
    plain("/register [wallet] — provision your mining wallet"),
    plain("/mine — choose a work type and get a task"),
    plain("/submit <work_type> <output> — submit work for verification"),
    plain("/status <job_id> — check a submission's status"),
    plain("/balance — your AXIS earned & verification rate"),
    plain("/export — reveal your key to mine on the web & terminal too"),
    plain("/epoch — current epoch, reward & progress"),
    plain("/leaderboard — top miners this epoch"),
    plain("/network — live difficulty, miners & supply"),
    plain("/about — protocol overview"),
    plain("/help — this message"),
    "",
    b("Reward formula"),
    code("AXIS = W × Q ÷ D")
  );

  bot.help((ctx) => ctx.replyWithMarkdownV2(text));
  bot.command("commands", (ctx) => ctx.replyWithMarkdownV2(text));
}

module.exports = { register };
