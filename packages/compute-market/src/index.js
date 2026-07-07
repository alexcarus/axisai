"use strict";

const express = require("express");
const { ethers } = require("ethers");
const config = require("./config");
const redis = require("./redis");
const { catalog, getTier, provider } = require("./models");
const { verifyAxisPayment } = require("./payments");
const { runInference, askAxis, askConfigured } = require("./inference");
const { getPhase, GENESIS_THRESHOLD_PCT } = require("./phase");
const { verifyMiner, verifyPayer } = require("./auth");
const { createJob, getJob, saveJob, claimNext, requeue, claimForOperator } = require("./jobs");
const { payMiner, canPayout, burnAxis } = require("./payout");
const { verifyResult } = require("./verify");
const { startFallbackWorker, serve: serveOperator } = require("./fallback");
const costcoverage = require("./costcoverage");
const {
  recordServed,
  recordRejected,
  getMiner,
  topMiners,
  isBlocked,
} = require("./reputation");

const app = express();
app.use(express.json({ limit: "256kb" }));

// CORS — the public website (and any client) calls this API from the browser.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type,x-wallet-address,x-timestamp,x-signature",
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Returned with every AI output. Keeps the marketplace an informational/research
// tool — not financial, investment, or professional advice.
const DISCLAIMER =
  "AI-generated output for informational and research purposes only. Not financial, investment, legal, or professional advice. You alone are responsible for any decision you make. Do your own research.";

// Hard hourly cap on free /ask calls across ALL clients. The per-IP limit keys
// on X-Forwarded-For, which a client can spoof to mint unlimited IPs; this
// global ceiling bounds the operator's AI spend regardless. Tune via env.
const ASK_GLOBAL_HOURLY_CAP = Number.parseInt(process.env.ASK_GLOBAL_HOURLY_CAP || "300", 10);

/** Buyers can pay once a treasury/payTo address exists. */
function paymentsReady() {
  return Boolean(config.payTo);
}

/** Running total of AXIS burned by the compute market (deflationary sink). */
async function totalBurnedAxis() {
  try {
    return (await redis.get("cm:burned:axis")) || "0";
  } catch (_) {
    return "0";
  }
}

/** Standard Genesis gate — returns a 503 body if still pre-25%, else null. */
async function gateOrNull() {
  const phase = await getPhase();
  if (phase.postGenesis) return null;
  return {
    error: `compute market activates after Genesis (${GENESIS_THRESHOLD_PCT}% of supply mined). Currently ${phase.percent}% mined.`,
    genesis_complete: false,
    percent_mined: phase.percent,
  };
}

async function claimTx(txHash) {
  // One inference/job per payment.
  return redis.set(`cm:tx:${txHash.toLowerCase()}`, String(Date.now()), "EX", 60 * 60 * 24 * 30, "NX");
}

/**
 * Operator-first fulfillment. When enabled and an operator backend (OmniRoute /
 * OpenAI / Anthropic) is configured, immediately claim the freshly-created job
 * off the miner queue and serve it with that backend — so the buyer's request
 * completes at once instead of waiting for a distributed miner. The serve() path
 * runs the revenue split and, on any inference error, requeues the job so a real
 * miner is still the fallback. Best-effort: never throws into the request.
 */
async function serveOperatorFirst(jobId) {
  if (!config.operatorFirst || !provider()) return false;
  try {
    const job = await claimForOperator(jobId); // atomically remove from miner queue
    if (!job) return false; // a miner already claimed it
    const tier = getTier(job.model);
    if (tier && tier.serve === "miner") {
      // Premium tier — hand it back to the distributed-miner queue so a miner runs
      // it on their OWN key. The fallback worker degrades it to Cloudflare only if
      // no miner claims it within the fallback window (never a stuck order).
      await requeue(job);
      return false;
    }
    await serveOperator(job);
    return true;
  } catch (_) {
    return false;
  }
}

// --------------------------------------------------------------------------- //
//                              Status / catalog                               //
// --------------------------------------------------------------------------- //
app.get("/health", async (_req, res) => {
  const phase = await getPhase();
  res.json({
    status: "ok",
    service: "axis-compute-market",
    active: phase.postGenesis && paymentsReady(),
    genesis_complete: phase.postGenesis,
    percent_mined: phase.percent,
    activates_at_percent: GENESIS_THRESHOLD_PCT,
    distributed_payouts: canPayout(),
    operator_direct: Boolean(provider()),
    operator_fallback_seconds: config.fallbackAfterSeconds,
    auto_sell: config.autoSell.enabled,
    pay_to: config.payTo || null,
    token: config.axisToken,
    burn_share: config.burnShare,
    total_burned_axis: await totalBurnedAxis(),
  });
});

app.get("/models", async (_req, res) => {
  const phase = await getPhase();
  res.json({
    token: config.axisToken,
    pay_to: config.payTo || null,
    active: phase.postGenesis && paymentsReady(),
    genesis_complete: phase.postGenesis,
    percent_mined: phase.percent,
    activates_at_percent: GENESIS_THRESHOLD_PCT,
    miner_share: config.minerShare,
    burn_share: config.burnShare,
    total_burned_axis: await totalBurnedAxis(),
    models: catalog(),
    disclaimer: DISCLAIMER,
  });
});

app.post("/quote", async (req, res) => {
  const tier = getTier(String(req.body?.model || ""));
  if (!tier)
    return res.status(400).json({ error: "unknown model tier", models: catalog().map((t) => t.id) });
  const gated = await gateOrNull();
  if (gated) return res.status(503).json(gated);
  if (!paymentsReady())
    return res.status(503).json({ error: "marketplace not configured (needs a treasury/payTo)" });
  return res.json({
    model: tier.id,
    label: tier.label,
    price_axis: tier.price_axis,
    pay_to: config.payTo,
    token: config.axisToken,
    instructions: `Send ${tier.price_axis} AXIS to ${config.payTo} on Base, then POST /request with { "model": "${tier.id}", "prompt": "...", "tx_hash": "0x..." } and poll /result/<job_id>.`,
  });
});

// --------------------------------------------------------------------------- //
//                          Buyer — distributed flow                           //
// --------------------------------------------------------------------------- //

// Pay AXIS, then submit a job for a distributed miner to serve.
app.post("/request", async (req, res) => {
  try {
    const gated = await gateOrNull();
    if (gated) return res.status(503).json(gated);
    if (!paymentsReady() || !canPayout())
      return res.status(503).json({ error: "distributed market not configured (needs a treasury key)" });

    const { model, prompt, tx_hash, payer, payer_signature } = req.body || {};
    const tier = getTier(String(model || ""));
    if (!tier) return res.status(400).json({ error: "unknown model tier" });
    if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "missing prompt" });
    if (!tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) return res.status(400).json({ error: "missing/invalid tx_hash" });
    if (!verifyPayer(payer, tx_hash, payer_signature))
      return res.status(401).json({ error: "missing/invalid payer signature — sign AXIS-COMPUTE-PAY|<payer>|<tx_hash> with the paying wallet" });

    const minWei = ethers.parseUnits(String(tier.price_axis), config.axisDecimals);
    let paidWei;
    try {
      paidWei = await verifyAxisPayment(tx_hash, minWei, payer);
    } catch (e) {
      return res.status(402).json({ error: `payment verification failed: ${e.message}` });
    }
    if (!(await claimTx(tx_hash))) return res.status(409).json({ error: "this payment was already used" });

    const minerShareWei = (paidWei * BigInt(Math.round(config.minerShare * 10000))) / 10000n;
    const jobId = await createJob({ model: tier.id, prompt, paidWei, minerShareWei });
    // OmniRoute-first, but non-blocking: kick off operator serving in the
    // background and return immediately so a slow route never hangs the request.
    // The buyer polls /result; if the operator errors, the job stays queued for
    // a distributed miner.
    serveOperatorFirst(jobId).catch(() => {});
    return res.json({ job_id: jobId, status: "processing", poll: `/result/${jobId}` });
  } catch (_e) {
    return res.status(500).json({ error: "internal error" });
  }
});

// Buyer polls for the result.
app.get("/result/:id", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found or expired" });
  return res.json({
    job_id: job.id,
    status: job.status,
    model: job.model,
    output: job.output,
    miner: job.miner,
    payout_tx: job.payout_tx,
    disclaimer: DISCLAIMER,
  });
});

// --------------------------------------------------------------------------- //
//                        Miner — serve compute, get paid                      //
// --------------------------------------------------------------------------- //

// A miner claims the next queued job.
app.post("/jobs/next", async (req, res) => {
  const gated = await gateOrNull();
  if (gated) return res.status(503).json(gated);
  const miner = verifyMiner(req.headers);
  if (!miner)
    return res.status(401).json({ error: "miner auth failed — sign AXIS-COMPUTE-MINER|<addr>|<ts>" });
  if (await isBlocked(miner))
    return res.status(403).json({ error: "miner temporarily blocked for low result quality" });
  const job = await claimNext(miner);
  if (!job) return res.json({ none: true });
  return res.json({ job_id: job.id, model: job.model, prompt: job.prompt });
});

// A miner submits its result and is paid the buyer's AXIS from the treasury.
app.post("/jobs/result", async (req, res) => {
  try {
    const gated = await gateOrNull();
    if (gated) return res.status(503).json(gated);
    const miner = verifyMiner(req.headers);
    if (!miner) return res.status(401).json({ error: "miner auth failed" });

    const { job_id, output } = req.body || {};
    const job = await getJob(job_id);
    if (!job) return res.status(404).json({ error: "job not found" });
    if (job.status === "done") return res.json({ ok: true, already: true, payout_tx: job.payout_tx });
    if (job.status !== "claimed") return res.status(409).json({ error: `job not claimable (status: ${job.status})` });
    if (String(job.miner).toLowerCase() !== miner.toLowerCase())
      return res.status(403).json({ error: "not your job" });
    if (!output || typeof output !== "string" || !output.trim())
      return res.status(400).json({ error: "empty output" });

    // Verify the result before paying. On rejection, requeue for another miner
    // (the bad miner earns nothing); after 3 failures the job is marked failed.
    const v = await verifyResult(job.prompt, output);
    if (!v.ok) {
      await recordRejected(miner);
      job.attempts = (job.attempts || 0) + 1;
      if (job.attempts >= 3) {
        job.status = "failed";
        job.fail_reason = v.reason;
        await saveJob(job);
        return res.status(422).json({ error: `result rejected: ${v.reason} (job failed after ${job.attempts} attempts)` });
      }
      job.attempts_reason = v.reason;
      await requeue(job);
      return res.status(422).json({ error: `result rejected: ${v.reason} — requeued for another miner` });
    }

    job.output = output;
    job.status = "paying";
    await saveJob(job);

    // Deduct a flat AXIS gas-fee so the treasury is reimbursed for the payout
    // gas (the miner covers their own gas; the operator never loses value).
    const gasFeeWei = ethers.parseUnits(String(config.gasFeeAxis), config.axisDecimals);
    let payWei = BigInt(job.miner_share_wei) - gasFeeWei;
    if (payWei < 1n) payWei = 1n;

    let payoutTx = null;
    try {
      payoutTx = await payMiner(miner, payWei);
    } catch (e) {
      job.status = "claimed"; // allow a retry
      await saveJob(job);
      return res.status(502).json({ error: `payout failed: ${e.message}` });
    }

    job.payout_tx = payoutTx;
    job.status = "done";
    await saveJob(job);
    await recordServed(miner, ethers.formatEther(payWei));

    // The AXIS protocol fee (paid − miner share) stays in the treasury. Split
    // it two ways, both plain ERC-20 / swap calls on the live token — NO
    // contract change: a deflationary burn, and a cost-coverage auto-sell.
    const feeWei = BigInt(job.paid_wei) - BigInt(job.miner_share_wei);

    // Deflationary sink: burn a share of the fee so every paid compute job
    // permanently shrinks AXIS supply. Best-effort — it never blocks the
    // buyer's result or the miner's payout.
    let burnTx = null;
    let burnedAxis = "0";
    let burnWei = 0n;
    try {
      burnWei = (feeWei * BigInt(Math.round(config.burnShare * 10000))) / 10000n;
      if (burnWei > 0n && canPayout()) {
        burnTx = await burnAxis(burnWei);
        burnedAxis = ethers.formatEther(burnWei);
        await redis.incrbyfloat("cm:burned:axis", burnedAxis);
      }
    } catch (_e) {
      burnWei = 0n; // burn didn't land — treat the whole fee as retained
      /* burn is best-effort — the token still deflates on subsequent jobs */
    }

    // Cost-coverage: auto-sell a bounded slice of the AXIS the treasury RETAINS
    // (fee minus what was burned) for ETH on the live Uniswap v4 ETH/AXIS pool,
    // then top the validator's gas back up out of that ETH. Off unless
    // AUTO_SELL_ENABLED, guarded against thin liquidity, best-effort — never
    // blocks the buyer's result or the miner's payout.
    try {
      const retainedWei = feeWei - burnWei;
      if (retainedWei > 0n) await costcoverage.coverCost(retainedWei, `job:${job.id}`);
      await costcoverage.topUpValidator(`job:${job.id}`);
    } catch (_e) {
      /* best-effort — treasury still refills on later jobs */
    }

    return res.json({
      ok: true,
      payout_tx: payoutTx,
      paid_axis: ethers.formatEther(payWei),
      gas_fee_axis: config.gasFeeAxis,
      burn_tx: burnTx,
      burned_axis: burnedAxis,
    });
  } catch (_e) {
    return res.status(500).json({ error: "internal error" });
  }
});

// --------------------------------------------------------------------------- //
//             Operator-direct (optional fallback, no miner needed)            //
// --------------------------------------------------------------------------- //
app.post("/infer", async (req, res) => {
  try {
    const gated = await gateOrNull();
    if (gated) return res.status(503).json(gated);
    if (!paymentsReady() || !provider())
      return res.status(503).json({ error: "operator-direct not configured (needs payTo + marketplace AI key)" });

    const { model, prompt, tx_hash, payer, payer_signature } = req.body || {};
    const tier = getTier(String(model || ""));
    if (!tier) return res.status(400).json({ error: "unknown model tier" });
    if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "missing prompt" });
    if (!tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) return res.status(400).json({ error: "missing/invalid tx_hash" });
    if (!verifyPayer(payer, tx_hash, payer_signature))
      return res.status(401).json({ error: "missing/invalid payer signature — sign AXIS-COMPUTE-PAY|<payer>|<tx_hash> with the paying wallet" });

    const minWei = ethers.parseUnits(String(tier.price_axis), config.axisDecimals);
    let paidWei;
    try {
      paidWei = await verifyAxisPayment(tx_hash, minWei, payer);
    } catch (e) {
      return res.status(402).json({ error: `payment verification failed: ${e.message}` });
    }
    if (!(await claimTx(tx_hash))) return res.status(409).json({ error: "this payment was already used" });

    let output;
    try {
      output = await runInference(tier, prompt);
    } catch (e) {
      await redis.del(`cm:tx:${tx_hash.toLowerCase()}`);
      return res.status(502).json({ error: `inference failed: ${e.message}` });
    }
    return res.json({ model: tier.id, ai_model: tier.model, paid_axis: ethers.formatEther(paidWei), tx_hash, output, disclaimer: DISCLAIMER });
  } catch (_e) {
    return res.status(500).json({ error: "internal error" });
  }
});

// --------------------------------------------------------------------------- //
//                      Miner reputation (leaderboard)                         //
// --------------------------------------------------------------------------- //
app.get("/miners", async (_req, res) => {
  res.json({ miners: await topMiners(20) });
});
app.get("/miner/:addr", async (req, res) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(req.params.addr || ""))
    return res.status(400).json({ error: "invalid address" });
  res.json(await getMiner(req.params.addr));
});

// --------------------------------------------------------------------------- //
//   Analysis — structured AI analysis (trading/decisions). Informational.     //
//   Same pay -> distributed-miner -> verify -> payout flow as /request.       //
// --------------------------------------------------------------------------- //
app.post("/analyze", async (req, res) => {
  try {
    const gated = await gateOrNull();
    if (gated) return res.status(503).json(gated);
    if (!paymentsReady() || !canPayout())
      return res.status(503).json({ error: "distributed market not configured (needs a treasury key)" });

    const { model, question, context, tx_hash, payer, payer_signature } = req.body || {};
    const tier = getTier(String(model || ""));
    if (!tier) return res.status(400).json({ error: "unknown model tier" });
    if (!question || typeof question !== "string") return res.status(400).json({ error: "missing question" });
    if (!tx_hash || !/^0x[0-9a-fA-F]{64}$/.test(tx_hash)) return res.status(400).json({ error: "missing/invalid tx_hash" });
    if (!verifyPayer(payer, tx_hash, payer_signature))
      return res.status(401).json({ error: "missing/invalid payer signature — sign AXIS-COMPUTE-PAY|<payer>|<tx_hash> with the paying wallet" });

    const prompt =
      "You are an objective analyst. Analyze the QUESTION (using the CONTEXT if given) and respond in this structure:\n" +
      "1) View / lean\n2) Confidence (0-100%)\n3) Key supporting factors\n4) Key risks and uncertainties\n" +
      "Be balanced and reason from evidence. This is informational analysis only — not financial, investment, or trading advice.\n\n" +
      `QUESTION:\n${String(question).slice(0, 6000)}\n\nCONTEXT:\n${String(context || "(none)").slice(0, 6000)}`;

    const minWei = ethers.parseUnits(String(tier.price_axis), config.axisDecimals);
    let paidWei;
    try {
      paidWei = await verifyAxisPayment(tx_hash, minWei, payer);
    } catch (e) {
      return res.status(402).json({ error: `payment verification failed: ${e.message}` });
    }
    if (!(await claimTx(tx_hash))) return res.status(409).json({ error: "this payment was already used" });

    const minerShareWei = (paidWei * BigInt(Math.round(config.minerShare * 10000))) / 10000n;
    const jobId = await createJob({ model: tier.id, prompt, paidWei, minerShareWei });
    serveOperatorFirst(jobId).catch(() => {});
    return res.json({
      job_id: jobId,
      status: "processing",
      kind: "analysis",
      poll: `/result/${jobId}`,
      disclaimer: DISCLAIMER,
    });
  } catch (_e) {
    return res.status(500).json({ error: "internal error" });
  }
});

// --------------------------------------------------------------------------- //
//        Ask AI about AXIS — free, rate-limited Q&A (not gated)               //
// --------------------------------------------------------------------------- //
app.post("/ask", async (req, res) => {
  try {
    const question = String(req.body?.question || "").trim();
    if (!question) return res.status(400).json({ error: "missing question" });
    if (question.length > 1000) return res.status(400).json({ error: "question too long (max 1000 chars)" });
    if (!askConfigured())
      return res.status(503).json({ error: "Ask AI is not configured yet (needs an AI key on the marketplace)" });

    // Rate limit per IP: 8 questions / hour.
    const ip =
      (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "unknown";
    const rlKey = `cm:ask:${ip}`;
    const n = await redis.incr(rlKey);
    if (n === 1) await redis.expire(rlKey, 3600);
    if (n > 8) return res.status(429).json({ error: "rate limit — try again in a bit" });

    // Global hourly ceiling — bounds AI spend even if X-Forwarded-For is spoofed.
    const gKey = "cm:ask:global";
    const g = await redis.incr(gKey);
    if (g === 1) await redis.expire(gKey, 3600);
    if (g > ASK_GLOBAL_HOURLY_CAP) {
      return res.status(429).json({ error: "ask is temporarily busy — try again later" });
    }

    let answer;
    try {
      answer = await askAxis(question);
    } catch (e) {
      return res.status(502).json({ error: `ask failed: ${e.message}` });
    }
    return res.json({ answer, disclaimer: DISCLAIMER });
  } catch (_e) {
    return res.status(500).json({ error: "internal error" });
  }
});

const server = app.listen(config.port, config.host, () => {
  console.log(`[axis-compute-market] listening on ${config.host}:${config.port}`);
  // Operator-direct fallback: serve queued jobs with the market's own AI key
  // when no distributed miner claims them (see fallback.js).
  startFallbackWorker();
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

module.exports = { app };
