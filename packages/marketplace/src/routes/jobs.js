"use strict";

const express = require("express");
const { ethers } = require("ethers");
const { query } = require("../db/pool");
const { messages, verify } = require("../crypto/verify");
const { matchQueue } = require("../queue");
const settlement = require("../services/settlement");
const logger = require("../logger");

const router = express.Router();

/**
 * @openapi
 * /jobs/request:
 *   post:
 *     summary: Create a compute job (locks escrow, async provider matching)
 *     tags: [Jobs]
 *     responses:
 *       202: { description: Job accepted and queued for matching }
 */
router.post("/jobs/request", async (req, res) => {
  try {
    const b = req.body || {};
    const required = ["model_id", "max_price_in_axis", "requester_wallet", "signature"];
    for (const f of required) if (b[f] === undefined || b[f] === "") return res.status(400).json({ error: `missing ${f}` });
    if (!ethers.isAddress(b.requester_wallet)) return res.status(400).json({ error: "invalid requester_wallet" });

    const expected = messages.jobRequest(b.requester_wallet, b.model_id, b.max_price_in_axis);
    if (!verify(b.requester_wallet, expected, b.signature)) {
      return res.status(401).json({ error: "signature invalid", expected_message: expected });
    }

    const { rows: modelRows } = await query(`SELECT * FROM models WHERE id = $1 AND active = true`, [b.model_id]);
    if (!modelRows[0]) return res.status(404).json({ error: "model not found" });
    const model = modelRows[0];

    const inputData = b.input_data != null ? String(typeof b.input_data === "string" ? b.input_data : JSON.stringify(b.input_data)) : "";
    const inputHash = ethers.keccak256(ethers.toUtf8Bytes(inputData));

    const { rows } = await query(
      `INSERT INTO jobs (model_id, requester_wallet, input_data, input_hash, work_type, max_price_in_axis, status)
       VALUES ($1,$2,$3,$4,$5,$6,'requested') RETURNING *`,
      [model.id, b.requester_wallet.toLowerCase(), inputData, inputHash, model.work_type, b.max_price_in_axis]
    );
    const job = rows[0];

    // Async matching + escrow lock + timeout scheduling.
    await matchQueue.add({ jobId: job.id }, { jobId: `match:${job.id}` });

    return res.status(202).json({ job_id: job.id, status: job.status, work_type: job.work_type });
  } catch (err) {
    logger.error("POST /jobs/request failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

/**
 * @openapi
 * /jobs/{id}/deliver:
 *   post:
 *     summary: Provider delivers output; routed to PoAIW engine; escrow settled
 *     tags: [Jobs]
 *     responses:
 *       200: { description: Delivery processed (completed or failed) }
 */
router.post("/jobs/:id/deliver", async (req, res) => {
  try {
    const b = req.body || {};
    if (!ethers.isAddress(b.provider_wallet)) return res.status(400).json({ error: "invalid provider_wallet" });
    if (b.output_data === undefined || b.output_data === "") return res.status(400).json({ error: "missing output_data" });

    const { rows } = await query(`SELECT * FROM jobs WHERE id = $1`, [req.params.id]);
    const job = rows[0];
    if (!job) return res.status(404).json({ error: "job not found" });
    if (job.status !== "matched") return res.status(409).json({ error: `job not deliverable in status ${job.status}` });
    if (job.provider_wallet && job.provider_wallet.toLowerCase() !== b.provider_wallet.toLowerCase()) {
      return res.status(403).json({ error: "not the assigned provider" });
    }

    const expected = messages.jobDeliver(b.provider_wallet, req.params.id);
    if (!verify(b.provider_wallet, expected, b.signature)) {
      return res.status(401).json({ error: "signature invalid", expected_message: expected });
    }

    const outputData = typeof b.output_data === "string" ? b.output_data : JSON.stringify(b.output_data);
    const outputHash = ethers.keccak256(ethers.toUtf8Bytes(outputData));
    await query(
      `UPDATE jobs SET output_data=$2, output_hash=$3, status='delivered', delivered_at=now() WHERE id=$1`,
      [req.params.id, outputData, outputHash]
    );

    // Route to the PoAIW engine for scoring and settle escrow accordingly.
    const result = await settlement.settleDelivery(req.params.id);
    return res.json({ job_id: req.params.id, ...result });
  } catch (err) {
    logger.error("POST /jobs/:id/deliver failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

/**
 * @openapi
 * /jobs/{id}:
 *   get:
 *     summary: Job status + settlement detail
 *     tags: [Jobs]
 *     responses:
 *       200: { description: Job }
 */
router.get("/jobs/:id", async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM jobs WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "job not found" });
    return res.json(rows[0]);
  } catch (err) {
    logger.error("GET /jobs/:id failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

/**
 * @openapi
 * /jobs/requester/{wallet}:
 *   get: { summary: Jobs created by a requester, tags: [Jobs], responses: { 200: { description: ok } } }
 */
router.get("/jobs/requester/:wallet", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM jobs WHERE requester_wallet = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.wallet.toLowerCase()]
    );
    return res.json({ jobs: rows });
  } catch (err) {
    logger.error("GET /jobs/requester failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

/**
 * @openapi
 * /jobs/provider/{wallet}:
 *   get: { summary: Jobs fulfilled by a provider, tags: [Jobs], responses: { 200: { description: ok } } }
 */
router.get("/jobs/provider/:wallet", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM jobs WHERE provider_wallet = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.wallet.toLowerCase()]
    );
    return res.json({ jobs: rows });
  } catch (err) {
    logger.error("GET /jobs/provider failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
