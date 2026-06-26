"use strict";

const verificationQueue = require("./queue/verificationQueue");
const { runVerification } = require("./pipeline/verify");
const { query } = require("./db/pool");
const minerSvc = require("./services/miner");
const config = require("./config");
const logger = require("./logger");

/**
 * Persists a final pipeline result to the submissions table and updates the
 * miner aggregate stats.
 */
async function persistResult(submission, result) {
  await query(
    `UPDATE submissions
       SET status = $2,
           quality = $3,
           workload = $4,
           difficulty = $5,
           reward = $6,
           reward_int = $7,
           epoch = $8,
           tx_hash = $9,
           reject_reason = $10,
           updated_at = now()
     WHERE job_id = $1`,
    [
      submission.job_id,
      result.status,
      result.quality ?? null,
      result.workload ?? null,
      result.difficulty ?? null,
      result.rewardAxis ?? 0,
      result.workload && result.qualityInt ? result.qualityInt : null,
      result.epoch ?? null,
      result.txHash ?? null,
      result.rejectReason ?? null,
    ]
  );

  // Persist scoring detail.
  const { rows } = await query(`SELECT id FROM submissions WHERE job_id = $1`, [submission.job_id]);
  if (rows[0]) {
    await query(
      `INSERT INTO scores (submission_id, work_type, quality, peer_score, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        rows[0].id,
        submission.work_type,
        result.quality ?? 0,
        result.peerScore ?? null,
        JSON.stringify(result.details || { rejectReason: result.rejectReason }),
      ]
    );
  }

  if (result.status === "approved") {
    await minerSvc.recordVerified(submission.wallet_address, result.rewardAxis || 0);
  } else if (result.status === "rejected") {
    await minerSvc.recordRejected(submission.wallet_address);
  }
}

/**
 * Registers the queue processor. Exported so the combined entrypoint can start
 * the worker in-process; also runnable standalone via `npm run worker`.
 */
function startWorker() {
  verificationQueue.process(config.queue.concurrency, async (job) => {
    const submission = job.data;
    logger.info("Processing verification job", { jobId: submission.job_id, bullId: job.id });

    await query(
      `UPDATE submissions SET status = 'verifying', updated_at = now() WHERE job_id = $1`,
      [submission.job_id]
    );

    let result;
    try {
      result = await runVerification(submission);
    } catch (err) {
      logger.error("Pipeline threw", { jobId: submission.job_id, error: err.message, stack: err.stack });
      result = { ok: false, status: "error", rejectReason: err.message };
    }

    await persistResult(submission, result);
    return result;
  });

  verificationQueue.on("failed", (job, err) => {
    logger.error("Verification job failed", { bullId: job.id, error: err.message });
  });
  verificationQueue.on("completed", (job, result) => {
    logger.info("Verification job completed", { bullId: job.id, status: result.status });
  });

  logger.info("Verification worker started", { concurrency: config.queue.concurrency });
}

if (require.main === module) {
  startWorker();
  const shutdown = async (sig) => {
    logger.info(`Worker received ${sig}, shutting down`);
    await verificationQueue.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

module.exports = { startWorker, persistResult };
