"use strict";

const { ethers } = require("ethers");
const config = require("./config");
const redis = require("./redis");
const { peekOldestQueued, claimForOperator, saveJob, requeue } = require("./jobs");
const { getTier, provider } = require("./models");
const { runInference } = require("./inference");
const costcoverage = require("./costcoverage");

/**
 * Operator-direct fallback worker.
 *
 * A paid /request or /analyze job is queued for a distributed miner to serve.
 * If no miner claims it within `fallbackAfterSeconds`, this worker serves it
 * with the market's OWN AI key so the buyer's request still completes. The
 * buyer already paid AXIS into the treasury; since the operator did the work,
 * there is no miner payout, and a bounded slice of that AXIS is auto-sold (when
 * enabled) to cover the operator's running cost.
 */

let timer = null;

async function serve(job) {
  const tier = getTier(job.model);
  if (!tier) {
    job.status = "failed";
    job.fail_reason = "unknown model tier";
    await saveJob(job);
    return { ok: false, reason: "unknown model tier" };
  }

  job.status = "serving_operator";
  await saveJob(job);

  let output;
  try {
    output = await runInference(tier, job.prompt);
  } catch (e) {
    // Couldn't serve (API error). Put it back so a real miner can still take it.
    await requeue(job);
    return { ok: false, reason: `operator inference failed: ${e.message}` };
  }

  job.output = output;
  job.miner = "operator";
  job.served_by = "operator";
  job.status = "done";
  await saveJob(job);

  // Cover the operator's cost by auto-selling a bounded slice of the buyer's
  // AXIS for ETH, then top the validator's gas back up (best-effort; never
  // blocks the buyer's result). The operator served this one, so the whole
  // payment is treasury revenue to draw the cost-coverage slice from.
  try {
    const paidWei = BigInt(job.paid_wei || "0");
    if (paidWei > 0n) {
      await costcoverage.coverCost(paidWei, `job:${job.id}`);
    }
    await costcoverage.topUpValidator(`job:${job.id}`);
  } catch (_) {
    /* best-effort */
  }

  return { ok: true, output };
}

async function tick() {
  try {
    const oldest = await peekOldestQueued();
    if (!oldest || oldest.status !== "queued") return;
    const age = Date.now() - (oldest.created_at || 0);
    if (age < config.fallbackAfterSeconds * 1000) return; // give miners first crack
    const job = await claimForOperator(oldest.id);
    if (!job) return; // a distributed miner claimed it first
    // eslint-disable-next-line no-console
    console.log(`[fallback] serving queued job ${job.id} (${job.model}) operator-direct`);
    const res = await serve(job);
    if (!res.ok) console.log(`[fallback] job ${job.id}: ${res.reason}`);
    else console.log(`[fallback] job ${job.id} served operator-direct`);
  } catch (_e) {
    /* best-effort worker — never throw out of the interval */
  }
}

/** Starts the fallback interval. No-op if disabled or no AI key is configured. */
function startFallbackWorker() {
  if (!config.fallbackAfterSeconds) return null; // disabled (0)
  if (!provider()) {
    // eslint-disable-next-line no-console
    console.log("[fallback] disabled — no AI key configured on the market");
    return null;
  }
  const intervalMs = Math.min(
    10000,
    Math.max(3000, Math.floor((config.fallbackAfterSeconds * 1000) / 2)),
  );
  timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  // eslint-disable-next-line no-console
  console.log(
    `[fallback] operator-direct fallback ON — serves queued jobs after ${config.fallbackAfterSeconds}s`,
  );
  return timer;
}

function stopFallbackWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Exposed for tests.
module.exports = { startFallbackWorker, stopFallbackWorker, tick, serve, redis, ethers };
