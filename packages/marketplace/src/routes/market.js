"use strict";

const express = require("express");
const market = require("../services/market");
const { limit, clientIp } = require("../rateLimit");
const logger = require("../logger");

const router = express.Router();

function fail(res, err, where) {
  const status = err.status || 500;
  if (status >= 500) logger.error(`${where} failed`, { error: err.message });
  return res.status(status).json({ error: err.message });
}

/**
 * Per-IP rate guard for the state-changing market endpoints. `max` requests per
 * 60s window. Applied to /market/quote and /market/execute, which write to the
 * persistent ledger and (when enabled) trigger bounded on-chain settlement.
 */
function rateGuard(max) {
  return async (req, res, next) => {
    const r = await limit(`${req.path}:${clientIp(req)}`, max, 60);
    if (!r.allowed) {
      return res.status(429).json({ error: "rate limit exceeded — slow down" });
    }
    return next();
  };
}

/**
 * @openapi
 * /market/quote:
 *   post:
 *     summary: Request an AI quote (price, fee, and liquidity↔miner split)
 *     tags: [Market]
 *     responses:
 *       200: { description: Quote }
 */
router.post("/market/quote", rateGuard(60), async (req, res) => {
  try {
    return res.json(await market.quote(req.body || {}));
  } catch (err) {
    return fail(res, err, "POST /market/quote");
  }
});

/**
 * @openapi
 * /market/execute:
 *   post:
 *     summary: Accept a quote and settle (splits liquidity + AXIS AI miner)
 *     tags: [Market]
 *     responses:
 *       200: { description: Settled fill }
 */
router.post("/market/execute", rateGuard(30), async (req, res) => {
  try {
    return res.json(await market.execute(req.body || {}));
  } catch (err) {
    return fail(res, err, "POST /market/execute");
  }
});

/**
 * @openapi
 * /market/book:
 *   get: { summary: Current mid, bid/ask, and depth, tags: [Market], responses: { 200: { description: Book } } }
 */
router.get("/market/book", async (req, res) => {
  try {
    return res.json(await market.book());
  } catch (err) {
    return fail(res, err, "GET /market/book");
  }
});

/**
 * @openapi
 * /market/stats:
 *   get: { summary: Mid, volume, liquidity + miner earnings, trader PnL, tags: [Market], responses: { 200: { description: Stats } } }
 */
router.get("/market/stats", async (req, res) => {
  try {
    return res.json(await market.stats());
  } catch (err) {
    return fail(res, err, "GET /market/stats");
  }
});

/**
 * @openapi
 * /market/fills:
 *   get: { summary: Recent settled fills, tags: [Market], responses: { 200: { description: Fills } } }
 */
router.get("/market/fills", async (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit || "30", 10);
    return res.json({ fills: await market.recentFills(limit) });
  } catch (err) {
    return fail(res, err, "GET /market/fills");
  }
});

module.exports = router;
