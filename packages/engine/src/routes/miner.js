"use strict";

const express = require("express");
const { ethers } = require("ethers");
const { query } = require("../db/pool");
const minerSvc = require("../services/miner");
const { getCooldown } = require("../services/cooldown");
const chain = require("../chain/contract");
const logger = require("../logger");

const router = express.Router();

/**
 * GET /miner/:wallet — miner profile: total submitted, total verified, total
 * AXIS earned, current cooldown status, on-chain balance and verification rate.
 */
router.get("/miner/:wallet", async (req, res) => {
  try {
    const wallet = req.params.wallet;
    if (!ethers.isAddress(wallet)) {
      return res.status(400).json({ error: "invalid wallet address" });
    }

    const miner = (await minerSvc.getMiner(wallet)) || {
      wallet_address: wallet.toLowerCase(),
      total_submitted: 0,
      total_verified: 0,
      total_rejected: 0,
      total_axis_earned: "0",
      first_seen: null,
    };

    const cooldown = await getCooldown(wallet);

    let onChainBalance = null;
    try {
      onChainBalance = ethers.formatEther(await chain.balanceOf(wallet));
    } catch (_) {
      /* chain optional */
    }

    // Submissions in the current epoch.
    const { rows: epochRows } = await query(
      `SELECT COUNT(*)::int AS count FROM submissions
        WHERE wallet_address = $1 AND status = 'approved'`,
      [wallet.toLowerCase()]
    );

    const totalSubmitted = Number(miner.total_submitted);
    const totalVerified = Number(miner.total_verified);
    const verificationRate = totalSubmitted > 0 ? totalVerified / totalSubmitted : 0;

    return res.json({
      wallet_address: miner.wallet_address,
      total_submitted: totalSubmitted,
      total_verified: totalVerified,
      total_rejected: Number(miner.total_rejected),
      total_axis_earned: miner.total_axis_earned,
      verification_rate: verificationRate,
      approved_submissions: epochRows[0].count,
      on_chain_balance_axis: onChainBalance,
      cooldown_seconds_remaining: cooldown,
      on_cooldown: cooldown > 0,
      first_seen: miner.first_seen,
    });
  } catch (err) {
    logger.error("GET /miner failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
