"use strict";

const express = require("express");
const pricing = require("../services/pricing");
const logger = require("../logger");

const router = express.Router();

/**
 * @openapi
 * /price/current:
 *   get:
 *     summary: Current market rate per TX in AXIS, plus demand/capacity units
 *     tags: [Pricing]
 *     responses:
 *       200: { description: Current price }
 */
router.get("/price/current", async (req, res) => {
  try {
    const cur = await pricing.current();
    return res.json({
      price_per_tx_axis: cur.price,
      demand_units: cur.demand,
      capacity_units: cur.capacity,
      base_price: cur.base_price,
      ts: cur.ts,
    });
  } catch (err) {
    logger.error("GET /price/current failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

/**
 * @openapi
 * /price/history:
 *   get:
 *     summary: Price snapshots for the last N hours
 *     tags: [Pricing]
 *     parameters: [{ in: query, name: hours, schema: { type: integer, default: 24 } }]
 *     responses:
 *       200: { description: Snapshot array }
 */
router.get("/price/history", async (req, res) => {
  try {
    const hours = Math.min(720, Math.max(1, parseInt(req.query.hours || "24", 10)));
    const snapshots = await pricing.history(hours);
    return res.json({ hours, snapshots });
  } catch (err) {
    logger.error("GET /price/history failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
