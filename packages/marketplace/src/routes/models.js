"use strict";

const express = require("express");
const { ethers } = require("ethers");
const { query } = require("../db/pool");
const { messages, verify } = require("../crypto/verify");
const logger = require("../logger");

const router = express.Router();

/**
 * @openapi
 * /models/publish:
 *   post:
 *     summary: Register a model as a native protocol asset
 *     tags: [Models]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, work_type, price_in_axis, owner_wallet, signature]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *               input_schema: { type: object }
 *               output_schema: { type: object }
 *               work_type: { type: string }
 *               price_in_axis: { type: number }
 *               owner_wallet: { type: string }
 *               signature: { type: string }
 *     responses:
 *       201: { description: Model published }
 */
router.post("/models/publish", async (req, res) => {
  try {
    const b = req.body || {};
    const required = ["name", "work_type", "price_in_axis", "owner_wallet", "signature"];
    for (const f of required) if (b[f] === undefined || b[f] === "") return res.status(400).json({ error: `missing ${f}` });
    if (!ethers.isAddress(b.owner_wallet)) return res.status(400).json({ error: "invalid owner_wallet" });

    const expected = messages.publish(b.owner_wallet, b.name, b.price_in_axis);
    if (!verify(b.owner_wallet, expected, b.signature)) {
      return res.status(401).json({ error: "ownership signature invalid", expected_message: expected });
    }

    const fingerprint = ethers.keccak256(
      ethers.toUtf8Bytes(`${b.name}|${b.owner_wallet.toLowerCase()}|${JSON.stringify(b.input_schema || {})}|${JSON.stringify(b.output_schema || {})}`)
    );

    const { rows } = await query(
      `INSERT INTO models (name, description, input_schema, output_schema, work_type, price_in_axis, owner_wallet, fingerprint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        b.name,
        b.description || null,
        b.input_schema ? JSON.stringify(b.input_schema) : null,
        b.output_schema ? JSON.stringify(b.output_schema) : null,
        b.work_type,
        b.price_in_axis,
        b.owner_wallet.toLowerCase(),
        fingerprint,
      ]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    logger.error("POST /models/publish failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

/**
 * @openapi
 * /models:
 *   get:
 *     summary: List models (paginated, filterable)
 *     tags: [Models]
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer } }
 *       - { in: query, name: work_type, schema: { type: string } }
 *       - { in: query, name: min_rating, schema: { type: number } }
 *       - { in: query, name: max_price, schema: { type: number } }
 *     responses:
 *       200: { description: Paged model list }
 */
router.get("/models", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "20", 10)));
    const offset = (page - 1) * limit;

    const filters = ["m.active = true"];
    const params = [];
    if (req.query.work_type) {
      params.push(req.query.work_type);
      filters.push(`m.work_type = $${params.length}`);
    }
    if (req.query.min_rating) {
      params.push(Number(req.query.min_rating));
      filters.push(`m.rating_avg >= $${params.length}`);
    }
    if (req.query.max_price) {
      params.push(Number(req.query.max_price));
      filters.push(`m.price_in_axis <= $${params.length}`);
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    // Default sort: provider_score descending (whitepaper reputation default).
    params.push(limit);
    params.push(offset);
    const { rows } = await query(
      `SELECT m.*, COALESCE(r.provider_score, 0) AS provider_score
         FROM models m
         LEFT JOIN reputation r ON r.wallet = m.owner_wallet
         ${where}
         ORDER BY provider_score DESC, m.rating_avg DESC, m.price_in_axis ASC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total FROM models m ${where}`,
      params.slice(0, params.length - 2)
    );

    return res.json({ page, limit, total: countRows[0].total, models: rows });
  } catch (err) {
    logger.error("GET /models failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

/**
 * @openapi
 * /models/{id}:
 *   get:
 *     summary: Model detail with usage stats and rating history
 *     tags: [Models]
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Model detail }
 *       404: { description: Not found }
 */
router.get("/models/:id", async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM models WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "model not found" });
    const { rows: ratings } = await query(
      `SELECT wallet, stars, created_at FROM model_ratings WHERE model_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );
    const { rows: jobStats } = await query(
      `SELECT COUNT(*)::int AS total_jobs,
              COUNT(*) FILTER (WHERE status='completed')::int AS completed_jobs
         FROM jobs WHERE model_id = $1`,
      [req.params.id]
    );
    return res.json({ ...rows[0], rating_history: ratings, usage: jobStats[0] });
  } catch (err) {
    logger.error("GET /models/:id failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

/**
 * @openapi
 * /models/{id}/rate:
 *   post:
 *     summary: Rate a model (1-5 stars), one rating per wallet
 *     tags: [Models]
 *     responses:
 *       200: { description: Rating recorded }
 */
router.post("/models/:id/rate", async (req, res) => {
  try {
    const b = req.body || {};
    const stars = parseInt(b.stars, 10);
    if (!(stars >= 1 && stars <= 5)) return res.status(400).json({ error: "stars must be 1..5" });
    if (!ethers.isAddress(b.wallet)) return res.status(400).json({ error: "invalid wallet" });

    const expected = messages.rate(b.wallet, req.params.id, stars);
    if (!verify(b.wallet, expected, b.signature)) {
      return res.status(401).json({ error: "signature invalid", expected_message: expected });
    }

    const { rows: modelRows } = await query(`SELECT id FROM models WHERE id = $1 AND active = true`, [req.params.id]);
    if (!modelRows[0]) return res.status(404).json({ error: "model not found" });

    await query(
      `INSERT INTO model_ratings (model_id, wallet, stars) VALUES ($1,$2,$3)
       ON CONFLICT (model_id, wallet) DO UPDATE SET stars = EXCLUDED.stars, created_at = now()`,
      [req.params.id, b.wallet.toLowerCase(), stars]
    );
    // Recompute aggregate rating.
    const { rows: agg } = await query(
      `SELECT AVG(stars)::float AS avg, COUNT(*)::int AS count FROM model_ratings WHERE model_id = $1`,
      [req.params.id]
    );
    await query(`UPDATE models SET rating_avg = $2, rating_count = $3 WHERE id = $1`, [
      req.params.id,
      agg[0].avg,
      agg[0].count,
    ]);
    return res.json({ ok: true, rating_avg: agg[0].avg, rating_count: agg[0].count });
  } catch (err) {
    logger.error("POST /models/:id/rate failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

/**
 * @openapi
 * /models/{id}:
 *   delete:
 *     summary: Remove a model (owner-only, signed)
 *     tags: [Models]
 *     responses:
 *       200: { description: Removed }
 */
router.delete("/models/:id", async (req, res) => {
  try {
    const b = req.body || {};
    if (!ethers.isAddress(b.owner_wallet)) return res.status(400).json({ error: "invalid owner_wallet" });
    const { rows } = await query(`SELECT * FROM models WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "model not found" });
    if (rows[0].owner_wallet.toLowerCase() !== b.owner_wallet.toLowerCase()) {
      return res.status(403).json({ error: "not the model owner" });
    }
    const expected = messages.deleteModel(b.owner_wallet, req.params.id);
    if (!verify(b.owner_wallet, expected, b.signature)) {
      return res.status(401).json({ error: "signature invalid", expected_message: expected });
    }
    await query(`UPDATE models SET active = false WHERE id = $1`, [req.params.id]);
    return res.json({ ok: true, removed: req.params.id });
  } catch (err) {
    logger.error("DELETE /models/:id failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
