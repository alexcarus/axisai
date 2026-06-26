"use strict";

const { query } = require("../db/pool");
const escrowSvc = require("./escrow");
const reputation = require("./reputation");
const { scoreDelivery } = require("./verification");
const config = require("../config");
const logger = require("../logger");

const FRAUD_QUALITY_THRESHOLD = 0.2;

/**
 * Selects the best available provider/model for a compute request: among active
 * models serving the requested work_type and priced within max_price, choose the
 * lowest price, then highest rating (whitepaper 7.4 marketplace matching).
 */
async function selectProvider(workType, maxPrice) {
  const { rows } = await query(
    `SELECT * FROM models
       WHERE active = true AND work_type = $1 AND price_in_axis <= $2
       ORDER BY price_in_axis ASC, rating_avg DESC, usage_count DESC
       LIMIT 1`,
    [workType, maxPrice]
  );
  return rows[0] || null;
}

/**
 * Async matching step (runs on the Bull match queue). Selects a provider, locks
 * escrow and transitions the job to 'matched'.
 */
async function matchJob(jobId) {
  const { rows } = await query(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  const job = rows[0];
  if (!job || job.status !== "requested") return;

  const model = await selectProvider(job.work_type, job.max_price_in_axis);
  if (!model) {
    await query(`UPDATE jobs SET status='failed', settled_at=now() WHERE id=$1`, [jobId]);
    logger.warn("no provider within budget", { jobId, workType: job.work_type });
    return;
  }

  const escrow = await escrowSvc.lock(job.id, job.requester_wallet, model.owner_wallet, model.price_in_axis);
  const deadline = new Date(Date.now() + config.jobs.timeoutSeconds * 1000);

  await query(
    `UPDATE jobs
       SET provider_wallet=$2, model_id=$3, price_in_axis=$4, status='matched',
           escrow_id=$5, deadline=$6
     WHERE id=$1`,
    [jobId, model.owner_wallet, model.id, model.price_in_axis, escrow.id, deadline]
  );
  await query(`UPDATE models SET usage_count = usage_count + 1 WHERE id = $1`, [model.id]);
  logger.info("job matched", { jobId, provider: model.owner_wallet, price: model.price_in_axis });
  return { provider: model.owner_wallet, price: model.price_in_axis };
}

/**
 * Settles a delivered job: score the output via the PoAIW engine, then release
 * escrow to the provider (verified) or refund the requester (failure / fraud).
 */
async function settleDelivery(jobId) {
  const { rows } = await query(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  const job = rows[0];
  if (!job) return null;
  if (!["matched", "delivered", "verifying"].includes(job.status)) return null;

  await query(`UPDATE jobs SET status='verifying', verification_status='pending' WHERE id=$1`, [jobId]);

  const { quality, passed, error } = await scoreDelivery(job.work_type, job.output_data);
  const deliverySeconds = job.delivered_at
    ? (Date.now() - new Date(job.delivered_at).getTime()) / 1000
    : (Date.now() - new Date(job.created_at).getTime()) / 1000;

  if (passed) {
    const rel = await escrowSvc.release(jobId);
    await query(
      `UPDATE jobs SET status='completed', verification_status='passed', quality=$2,
                       settlement_tx=$3, settled_at=now() WHERE id=$1`,
      [jobId, quality, rel ? rel.txHash : null]
    );
    await reputation.onJobCompleted(job.provider_wallet, deliverySeconds, true);
    await reputation.onRequesterPayment(job.requester_wallet);
    logger.info("job completed & escrow released", { jobId, quality });
    return { status: "completed", quality, txHash: rel ? rel.txHash : null };
  }

  // Failure path: refund. Treat very low quality as fraud (flag the provider).
  const isFraud = quality < FRAUD_QUALITY_THRESHOLD;
  const settle = isFraud ? await escrowSvc.flagFraud(jobId) : await escrowSvc.refund(jobId, "failure_refund");
  await query(
    `UPDATE jobs SET status='failed', verification_status='failed', quality=$2,
                     settlement_tx=$3, settled_at=now() WHERE id=$1`,
    [jobId, quality, settle ? settle.txHash : null]
  );
  await reputation.onJobFailed(job.provider_wallet, true);
  logger.warn("job failed & escrow refunded", { jobId, quality, isFraud, error });
  return { status: "failed", quality, fraud: isFraud, txHash: settle ? settle.txHash : null };
}

/**
 * Handles a job timeout (runs on the Bull timeout queue): if the job was never
 * delivered/settled, refund the requester and mark it timed out.
 */
async function handleTimeout(jobId) {
  const { rows } = await query(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  const job = rows[0];
  if (!job) return;
  if (!["matched", "requested"].includes(job.status)) return; // already settled/delivered

  await escrowSvc.refund(jobId, "timeout_refund");
  await query(`UPDATE jobs SET status='timeout', settled_at=now() WHERE id=$1`, [jobId]);
  if (job.provider_wallet) await reputation.onJobFailed(job.provider_wallet, false);
  logger.warn("job timed out & refunded", { jobId });
}

module.exports = { selectProvider, matchJob, settleDelivery, handleTimeout };
