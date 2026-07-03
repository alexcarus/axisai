"use strict";

const express = require("express");
const { ethers } = require("ethers");
const { query, pool } = require("../db/pool");
const { messages, verify } = require("../crypto/verify");
const logger = require("../logger");

const router = express.Router();

/**
 * @openapi
 * /capacity/offer:
 *   post:
 *     summary: List TX capacity for sale
 *     tags: [Capacity]
 *     responses:
 *       201: { description: Offer created }
 */
router.post("/capacity/offer", async (req, res) => {
  try {
    const b = req.body || {};
    const required = ["provider_wallet", "tx_units", "price_per_tx_in_axis", "expiry_timestamp", "signature"];
    for (const f of required) if (b[f] === undefined || b[f] === "") return res.status(400).json({ error: `missing ${f}` });
    if (!ethers.isAddress(b.provider_wallet)) return res.status(400).json({ error: "invalid provider_wallet" });

    const units = parseInt(b.tx_units, 10);
    if (!(units > 0)) return res.status(400).json({ error: "tx_units must be > 0" });

    const expected = messages.capacityOffer(b.provider_wallet, b.tx_units, b.price_per_tx_in_axis, b.expiry_timestamp);
    if (!verify(b.provider_wallet, expected, b.signature)) {
      return res.status(401).json({ error: "signature invalid", expected_message: expected });
    }

    const expiry = new Date(Number(b.expiry_timestamp));
    if (isNaN(expiry.getTime())) return res.status(400).json({ error: "invalid expiry_timestamp (ms epoch)" });

    const { rows } = await query(
      `INSERT INTO capacity_offers (provider_wallet, tx_units, remaining_units, price_per_tx_axis, expiry)
       VALUES ($1,$2,$2,$3,$4) RETURNING *`,
      [b.provider_wallet.toLowerCase(), units, b.price_per_tx_in_axis, expiry]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    logger.error("POST /capacity/offer failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

/**
 * @openapi
 * /capacity:
 *   get:
 *     summary: Available TX capacity offers sorted by price
 *     tags: [Capacity]
 *     responses:
 *       200: { description: Offers }
 */
router.get("/capacity", async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM capacity_offers
        WHERE active = true AND expiry > now() AND remaining_units > 0
        ORDER BY price_per_tx_axis ASC, created_at ASC
        LIMIT 200`
    );
    return res.json({ offers: rows });
  } catch (err) {
    logger.error("GET /capacity failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

/**
 * @openapi
 * /capacity/purchase:
 *   post:
 *     summary: Purchase TX units from an offer (AXIS settled at purchase)
 *     tags: [Capacity]
 *     responses:
 *       200: { description: Purchase recorded }
 */
router.post("/capacity/purchase", async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const required = ["buyer_wallet", "offer_id", "units_to_buy", "signature"];
    for (const f of required) if (b[f] === undefined || b[f] === "") return res.status(400).json({ error: `missing ${f}` });
    if (!ethers.isAddress(b.buyer_wallet)) return res.status(400).json({ error: "invalid buyer_wallet" });
    const units = parseInt(b.units_to_buy, 10);
    if (!(units > 0)) return res.status(400).json({ error: "units_to_buy must be > 0" });

    const expected = messages.capacityPurchase(b.buyer_wallet, b.offer_id, units);
    if (!verify(b.buyer_wallet, expected, b.signature)) {
      return res.status(401).json({ error: "signature invalid", expected_message: expected });
    }

    await client.query("BEGIN");
    // Lock the offer row for the duration of the purchase.
    const { rows: offerRows } = await client.query(
      `SELECT * FROM capacity_offers WHERE id = $1 FOR UPDATE`,
      [b.offer_id]
    );
    const offer = offerRows[0];
    if (!offer || !offer.active || new Date(offer.expiry) <= new Date()) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "offer unavailable" });
    }
    if (Number(offer.remaining_units) < units) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "insufficient remaining units", remaining: offer.remaining_units });
    }

    const total = Number(offer.price_per_tx_axis) * units;

    // SECURITY: the purchase is recorded off-chain ONLY. The buyer here just
    // signs a message — there is NO verified on-chain buyer payment — so paying
    // the seller from the operator/treasury wallet would let anyone drain it:
    // post a high-priced offer you sign, then "buy" it from a throwaway wallet
    // for free and pocket the payout. On-chain settlement must wait for a
    // verified buyer payment (see the compute market's pay-then-verify flow)
    // before it can be safely enabled.
    const transfer = { txHash: null, onchain: false };

    const remaining = Number(offer.remaining_units) - units;
    await client.query(
      `UPDATE capacity_offers SET remaining_units = $2, active = $3 WHERE id = $1`,
      [offer.id, remaining, remaining > 0]
    );
    const { rows: purchaseRows } = await client.query(
      `INSERT INTO capacity_purchases (offer_id, buyer_wallet, units, total_price_axis, tx_hash)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [offer.id, b.buyer_wallet.toLowerCase(), units, total, transfer.txHash]
    );
    await client.query("COMMIT");

    return res.json({
      purchase: purchaseRows[0],
      total_price_axis: total,
      settlement_tx: transfer.txHash,
      onchain: transfer.onchain,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error("POST /capacity/purchase failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  } finally {
    client.release();
  }
});

module.exports = router;
