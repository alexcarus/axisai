"use strict";

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { ethers } = require("ethers");
const { query } = require("../db/pool");
const verificationQueue = require("../queue/verificationQueue");
const { isValidWorkType } = require("../scoring");
const { isOnCooldown, getCooldown } = require("../services/cooldown");
const { verifySubmissionSignature, verifyOutputCommitment } = require("../crypto/signature");
const minerSvc = require("../services/miner");
const chain = require("../chain/contract");
const { computeWorkload } = require("../services/workload");
const { parseOutput } = require("../pipeline/verify");
const logger = require("../logger");

const router = express.Router();

/**
 * POST /submit — accept a work submission and queue it for verification.
 *
 * Body: { wallet_address, work_type, input_hash, output_hash, output_data,
 *         timestamp, signature }
 *
 * SECURITY: authenticity (signature) and integrity (output commitment) are
 * verified SYNCHRONOUSLY here, BEFORE any side-effect (DB row, stat counter,
 * cooldown, queue). This prevents (a) cooldown-griefing of arbitrary wallets via
 * unauthenticated submissions, and (b) stat pollution. Replay/double-mint is
 * prevented by a UNIQUE constraint on the (single-use) submission signature.
 */
router.post("/submit", async (req, res) => {
  try {
    const body = req.body || {};
    const required = [
      "wallet_address",
      "work_type",
      "input_hash",
      "output_hash",
      "output_data",
      "timestamp",
      "signature",
    ];
    for (const f of required) {
      if (body[f] === undefined || body[f] === null || body[f] === "") {
        return res.status(400).json({ error: `missing field: ${f}` });
      }
    }

    if (!ethers.isAddress(body.wallet_address)) {
      return res.status(400).json({ error: "invalid wallet_address" });
    }
    if (!isValidWorkType(body.work_type)) {
      return res.status(400).json({ error: `unsupported work_type: ${body.work_type}` });
    }

    // 1) AUTHENTICITY — verify the signature before doing anything else. An
    //    unauthenticated request must produce NO side-effects whatsoever.
    if (!verifySubmissionSignature(body)) {
      logger.warn("Rejected unauthenticated submission", { wallet: body.wallet_address });
      return res.status(401).json({ error: "signature verification failed" });
    }

    // 2) INTEGRITY — output_hash must commit to output_data exactly.
    if (!verifyOutputCommitment(body.output_data, body.output_hash)) {
      return res.status(400).json({ error: "output hash commitment mismatch" });
    }

    // 3) Cooldown — only checked AFTER ownership is proven (so it can never be
    //    triggered or probed for a wallet the caller does not control).
    if (await isOnCooldown(body.wallet_address)) {
      const remaining = await getCooldown(body.wallet_address);
      return res.status(429).json({ error: "wallet on cooldown", retry_after_seconds: remaining });
    }

    const jobId = uuidv4();
    const submission = {
      job_id: jobId,
      wallet_address: body.wallet_address,
      work_type: body.work_type,
      input_hash: body.input_hash,
      output_hash: body.output_hash,
      output_data: body.output_data,
      timestamp: body.timestamp,
      signature: body.signature,
    };

    // 4) REPLAY PROTECTION — the submission signature is single-use. A UNIQUE
    //    index makes the insert the atomic point of claim; a replay (identical
    //    signed body) collides and is rejected. Works across engine instances.
    try {
      await query(
        `INSERT INTO submissions (job_id, wallet_address, work_type, input_hash, output_hash, signature, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
        [
          jobId,
          body.wallet_address.toLowerCase(),
          body.work_type,
          body.input_hash,
          body.output_hash,
          body.signature,
        ]
      );
    } catch (e) {
      if (e && e.code === "23505") {
        logger.warn("Rejected replayed submission", { wallet: body.wallet_address });
        return res.status(409).json({ error: "duplicate submission (replay detected)" });
      }
      throw e;
    }

    await minerSvc.incrementSubmitted(body.wallet_address);

    // Enqueue for async verification.
    await verificationQueue.add(submission, { jobId });

    // Provide an estimated reward for UX (best-effort).
    let estReward = null;
    try {
      const parsed = parseOutput(body.output_data);
      const w = computeWorkload(body.work_type, parsed);
      const previewWei = await chain.previewReward(w, 100); // optimistic Q=1.0 preview
      estReward = ethers.formatEther(previewWei);
    } catch (_) {
      /* preview is best-effort */
    }

    logger.info("Submission queued", { jobId, wallet: body.wallet_address, work_type: body.work_type });
    return res.status(202).json({
      job_id: jobId,
      status: "pending",
      estimated_processing_seconds: 5,
      estimated_max_reward_axis: estReward,
    });
  } catch (err) {
    logger.error("POST /submit failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
