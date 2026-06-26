"use strict";

const express = require("express");
const { ethers } = require("ethers");
const { query } = require("../db/pool");
const chain = require("../chain/contract");
const logger = require("../logger");

const router = express.Router();

/**
 * GET /network/stats — current D, current epoch, total mined, % of supply, and
 * miners active in the last 24h.
 */
router.get("/network/stats", async (req, res) => {
  try {
    let state = null;
    try {
      state = await chain.getNetworkState();
    } catch (err) {
      logger.warn("network/stats chain read failed", { error: err.message });
    }

    const { rows: activeRows } = await query(
      `SELECT COUNT(DISTINCT wallet_address)::int AS active
         FROM submissions WHERE created_at > now() - interval '24 hours'`
    );

    const totalMined = state ? ethers.formatEther(state.totalMinted) : null;
    const maxSupply = state ? ethers.formatEther(state.maxSupply) : "84000000";
    const percentOfSupply =
      state && state.maxSupply > 0n
        ? Number((state.totalMinted * 1000000n) / state.maxSupply) / 10000
        : null;

    return res.json({
      difficulty: state ? Number(state.difficulty) : null,
      base_difficulty: state ? Number(state.baseDifficulty ?? state.difficulty) : null,
      // Automatic post-Genesis (>25%) difficulty multiplier (1.0 = no ramp yet).
      supply_difficulty_multiplier: state
        ? Number(state.supplyDifficultyMultiplier ?? 10000n) / 10000
        : null,
      epoch: state ? state.epoch : null,
      base_reward_axis: state ? ethers.formatEther(state.baseReward) : null,
      total_mined_axis: totalMined,
      max_supply_axis: maxSupply,
      percent_of_supply_mined: percentOfSupply,
      genesis_supply_axis: "21000000",
      active_miners_24h: activeRows[0].active,
    });
  } catch (err) {
    logger.error("GET /network/stats failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

/**
 * GET /network/leaderboard — top 20 miners by AXIS earned in the current epoch.
 */
router.get("/network/leaderboard", async (req, res) => {
  try {
    let epoch = null;
    try {
      epoch = (await chain.getNetworkState()).epoch;
    } catch (_) {
      /* fall back to all-time if chain unavailable */
    }

    let rows;
    if (epoch != null) {
      ({ rows } = await query(
        `SELECT wallet_address, SUM(reward)::numeric AS axis_earned, COUNT(*)::int AS verified
           FROM submissions
          WHERE status = 'approved' AND epoch = $1
          GROUP BY wallet_address
          ORDER BY axis_earned DESC
          LIMIT 20`,
        [epoch]
      ));
    } else {
      ({ rows } = await query(
        `SELECT wallet_address, SUM(reward)::numeric AS axis_earned, COUNT(*)::int AS verified
           FROM submissions
          WHERE status = 'approved'
          GROUP BY wallet_address
          ORDER BY axis_earned DESC
          LIMIT 20`
      ));
    }

    return res.json({
      epoch,
      leaderboard: rows.map((r, i) => ({
        rank: i + 1,
        wallet_address: r.wallet_address,
        axis_earned: r.axis_earned,
        verified_submissions: r.verified,
      })),
    });
  } catch (err) {
    logger.error("GET /network/leaderboard failed", { error: err.message });
    return res.status(500).json({ error: "internal error" });
  }
});

module.exports = router;
