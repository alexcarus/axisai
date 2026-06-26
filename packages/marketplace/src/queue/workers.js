"use strict";

const { matchQueue, timeoutQueue } = require("./index");
const settlement = require("../services/settlement");
const config = require("../config");
const logger = require("../logger");

/**
 * Registers the marketplace queue workers:
 *  - match: select a provider + lock escrow for new requests, then schedule the
 *    job's timeout.
 *  - timeout: refund the requester if a matched job was never delivered.
 */
function startWorkers() {
  matchQueue.process(4, async (job) => {
    const { jobId } = job.data;
    const result = await settlement.matchJob(jobId);
    if (result) {
      // Schedule the timeout refund once the job is matched.
      await timeoutQueue.add({ jobId }, { delay: config.jobs.timeoutSeconds * 1000, jobId: `timeout:${jobId}` });
    }
    return result || { matched: false };
  });

  timeoutQueue.process(4, async (job) => {
    await settlement.handleTimeout(job.data.jobId);
    return { handled: true };
  });

  matchQueue.on("failed", (job, err) => logger.error("match job failed", { id: job.id, error: err.message }));
  timeoutQueue.on("failed", (job, err) => logger.error("timeout job failed", { id: job.id, error: err.message }));

  logger.info("Marketplace queue workers started");
}

module.exports = { startWorkers };
