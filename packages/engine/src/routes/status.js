"use strict";

const express = require("express");
const { query } = require("../db/pool");
const logger = require("../logger");

const router = express.Router();

/**
 * GET /status/:jobId — return job status, score, reward amount and tx hash.
 */
router.get("/status/:jobId", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT job_id, wallet_address, work_type, status, quality, workload,
              difficulty, reward, epoch, tx_hash, reject_reason, created_at, updated_at
         FROM submissions WHERE job_id = $1`,
      [req.params.jobId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "job not found" });
    }
    const s = rows[0];
    return res.json({
      job_id: s.job_id,
      wallet_address: s.wallet_address,
      work_type: s.work_type,
      status: s.status,
      quality: s.quality,
      workload: s.workload,
      difficulty: s.difficulty,
      reward_axis: s.reward,
      epoch: s.epoch,
      tx_hash: s.tx_hash,
      reject_reason: s.reject_reason,
      created_at: s.created_at,
      updated_at: s.updated_at,
    });
  } catch (err) {
    logger.error("GET /status failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
