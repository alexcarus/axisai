"use strict";

const express = require("express");
const { ethers } = require("ethers");
const reputation = require("../services/reputation");
const logger = require("../logger");

const router = express.Router();

/**
 * @openapi
 * /reputation/{wallet}:
 *   get:
 *     summary: Provider and requester reputation scores for a wallet
 *     tags: [Reputation]
 *     parameters: [{ in: path, name: wallet, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: Reputation record }
 */
router.get("/reputation/:wallet", async (req, res) => {
  try {
    if (!ethers.isAddress(req.params.wallet)) return res.status(400).json({ error: "invalid wallet" });
    const rep = await reputation.get(req.params.wallet);
    return res.json(rep);
  } catch (err) {
    logger.error("GET /reputation/:wallet failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
