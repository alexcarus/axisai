"use strict";

const { ethers } = require("ethers");
const logger = require("../logger");
const config = require("../config");
const chain = require("../chain/contract");
const { verifySubmissionSignature, verifyOutputCommitment } = require("../crypto/signature");
const { scoreSubmission, isValidWorkType } = require("../scoring");
const { computeWorkload } = require("../services/workload");
const peerSvc = require("../services/peerSample");
const { applyCooldown } = require("../services/cooldown");

/**
 * Parses output_data, which may arrive as a JSON string or an object.
 */
function parseOutput(outputData) {
  if (outputData == null) return {};
  if (typeof outputData === "object") return outputData;
  try {
    return JSON.parse(outputData);
  } catch (_) {
    return { text: String(outputData), output: String(outputData) };
  }
}

/**
 * Builds a rejection result and applies the wallet cooldown. Use ONLY for
 * failures by the authenticated wallet owner (low quality / fraud) — never for
 * authenticity failures, otherwise an attacker could grief a victim's wallet.
 */
async function reject(submission, reason, extra = {}) {
  logger.warn("Submission rejected", { jobId: submission.job_id, wallet: submission.wallet_address, reason });
  await applyCooldown(submission.wallet_address);
  return {
    ok: false,
    status: "rejected",
    rejectReason: reason,
    quality: extra.quality || 0,
    ...extra,
  };
}

/**
 * Rejection WITHOUT a cooldown — for authenticity/integrity failures (bad
 * signature, hash mismatch, malformed request). These cannot be attributed to
 * the named wallet's owner, so applying a cooldown would enable griefing.
 */
function rejectNoCooldown(submission, reason, extra = {}) {
  logger.warn("Submission rejected (no cooldown)", {
    jobId: submission.job_id,
    wallet: submission.wallet_address,
    reason,
  });
  return { ok: false, status: "rejected", rejectReason: reason, quality: 0, ...extra };
}

/**
 * Runs the full PoAIW verification pipeline for a single submission. Each of the
 * ten whitepaper-mandated steps is implemented and logged.
 *
 * @param {object} submission Full submission record.
 * @returns {Promise<object>} Pipeline result.
 */
async function runVerification(submission) {
  const ctx = { jobId: submission.job_id, wallet: submission.wallet_address, work_type: submission.work_type };

  // Step 1 — Receive (already received; validate shape).
  logger.info("Pipeline step 1: receive", ctx);
  if (!submission.wallet_address || !ethers.isAddress(submission.wallet_address)) {
    return rejectNoCooldown(submission, "invalid wallet_address");
  }
  if (!isValidWorkType(submission.work_type)) {
    return rejectNoCooldown(submission, `unsupported work_type: ${submission.work_type}`);
  }

  // Step 2 — Verify signature (authenticity; no cooldown on failure).
  logger.info("Pipeline step 2: verify signature", ctx);
  if (!verifySubmissionSignature(submission)) {
    return rejectNoCooldown(submission, "signature verification failed");
  }

  // Step 3 — Validate output hash commitment (integrity; no cooldown on failure).
  logger.info("Pipeline step 3: verify output commitment", ctx);
  if (!verifyOutputCommitment(submission.output_data, submission.output_hash)) {
    return rejectNoCooldown(submission, "output hash commitment mismatch");
  }

  const parsed = parseOutput(submission.output_data);

  // Step 5 prep — assemble peer context for scoring functions that need it.
  let peerContext = {};
  if (submission.work_type === "dataset_labeling") {
    peerContext.batchLabels = await peerSvc.getBatchLabelDistribution(parsed.batch_id);
  } else if (submission.work_type === "peer_validation") {
    peerContext.targetRatings = await peerSvc.getTargetRatings(parsed.target_submission);
  }

  // Step 4 — Work-type-specific scoring -> Q.
  logger.info("Pipeline step 4: score", ctx);
  const { quality, details } = scoreSubmission(submission.work_type, parsed, peerContext);
  logger.info("Scored", { ...ctx, quality, details });

  // Step 5 — Peer validation: sample prior submissions of same type, cross-check.
  logger.info("Pipeline step 5: peer cross-check", ctx);
  const peers = await peerSvc.samplePeers(submission.work_type);
  const { peerScore, peerMean, sampled } = peerSvc.crossCheck(quality, peers);
  logger.info("Peer cross-check", { ...ctx, peerScore, peerMean, sampled });

  // Sharp inconsistency against an existing peer baseline is treated as fraud.
  if (sampled >= 1 && peerScore < 0.4) {
    return reject(submission, "peer inconsistency (possible fraud)", { quality, peerScore });
  }

  // Quality gate.
  if (quality < config.verification.minQuality) {
    return reject(submission, `quality ${quality.toFixed(3)} below threshold ${config.verification.minQuality}`, {
      quality,
      peerScore,
    });
  }

  // Step 6 — Compute W.
  logger.info("Pipeline step 6: compute workload", ctx);
  const workload = computeWorkload(submission.work_type, parsed);

  // Step 7 — Fetch current D from the smart contract.
  logger.info("Pipeline step 7: fetch difficulty", ctx);
  let difficulty;
  let networkState;
  try {
    networkState = await chain.getNetworkState();
    difficulty = networkState.difficulty;
  } catch (err) {
    logger.error("Failed to read chain state", { ...ctx, error: err.message });
    return { ok: false, status: "error", rejectReason: `chain read failed: ${err.message}`, quality, peerScore };
  }

  // Step 8 — Compute reward = W x Q / D (previewed on-chain to match minting).
  logger.info("Pipeline step 8: compute reward", ctx);
  const qualityInt = Math.max(1, Math.min(100, Math.round(quality * 100)));
  let rewardWei;
  try {
    rewardWei = await chain.previewReward(workload, qualityInt);
  } catch (err) {
    return { ok: false, status: "error", rejectReason: `preview failed: ${err.message}`, quality, peerScore };
  }
  const rewardHuman = ethers.formatEther(rewardWei);

  if (rewardWei <= 0n) {
    return reject(submission, "computed reward is zero", { quality, peerScore });
  }

  // Record this submission into the peer caches for future cross-checks.
  await peerSvc.recordSubmission(submission.work_type, {
    jobId: submission.job_id,
    wallet: submission.wallet_address,
    quality,
    outputHash: submission.output_hash,
  });
  if (submission.work_type === "dataset_labeling") {
    await peerSvc.recordBatchLabels(parsed.batch_id, parsed.labels);
  } else if (submission.work_type === "peer_validation") {
    await peerSvc.recordTargetRating(parsed.target_submission, parsed.rating);
  }

  // Step 9 — Build and submit the on-chain proof via the ValidatorRegistry.
  logger.info("Pipeline step 9: submit on-chain proof", { ...ctx, workload, qualityInt });
  let txHash = null;
  let mintedWei = rewardWei;
  try {
    const res = await chain.submitWork(submission.wallet_address, workload, qualityInt);
    txHash = res.txHash;
    mintedWei = res.minted;
  } catch (err) {
    logger.error("On-chain submission failed", { ...ctx, error: err.message });
    return { ok: false, status: "error", rejectReason: `on-chain submit failed: ${err.message}`, quality, peerScore, workload };
  }

  const mintedHuman = ethers.formatEther(mintedWei);
  logger.info("Pipeline complete: approved", { ...ctx, txHash, mintedHuman });

  // Step 10 handled by reject() on the failure branches above.
  return {
    ok: true,
    status: "approved",
    quality,
    qualityInt,
    peerScore,
    workload,
    difficulty: Number(difficulty),
    epoch: networkState.epoch,
    rewardWei: rewardWei.toString(),
    rewardHuman,
    mintedWei: mintedWei.toString(),
    rewardAxis: mintedHuman,
    txHash,
    details,
  };
}

module.exports = { runVerification, parseOutput };
