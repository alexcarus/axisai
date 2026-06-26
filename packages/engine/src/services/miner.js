"use strict";

const { query } = require("../db/pool");

/**
 * Miner record helpers — upsert aggregate stats used by the /miner and
 * /leaderboard endpoints and shared with the bots.
 */

/** Ensures a miner row exists. */
async function ensureMiner(wallet) {
  await query(
    `INSERT INTO miners (wallet_address) VALUES ($1)
     ON CONFLICT (wallet_address) DO NOTHING`,
    [wallet.toLowerCase()]
  );
}

/** Increments the submitted counter. */
async function incrementSubmitted(wallet) {
  await ensureMiner(wallet);
  await query(
    `UPDATE miners SET total_submitted = total_submitted + 1, updated_at = now()
     WHERE wallet_address = $1`,
    [wallet.toLowerCase()]
  );
}

/** Records a verified submission and adds the earned AXIS (human units). */
async function recordVerified(wallet, axisEarned) {
  await ensureMiner(wallet);
  await query(
    `UPDATE miners
       SET total_verified = total_verified + 1,
           total_axis_earned = total_axis_earned + $2,
           updated_at = now()
     WHERE wallet_address = $1`,
    [wallet.toLowerCase(), axisEarned]
  );
}

/** Records a rejected submission. */
async function recordRejected(wallet) {
  await ensureMiner(wallet);
  await query(
    `UPDATE miners SET total_rejected = total_rejected + 1, updated_at = now()
     WHERE wallet_address = $1`,
    [wallet.toLowerCase()]
  );
}

/** Reads a miner's aggregate record. */
async function getMiner(wallet) {
  const { rows } = await query(
    `SELECT wallet_address, total_submitted, total_verified, total_rejected,
            total_axis_earned, first_seen
       FROM miners WHERE wallet_address = $1`,
    [wallet.toLowerCase()]
  );
  return rows[0] || null;
}

module.exports = {
  ensureMiner,
  incrementSubmitted,
  recordVerified,
  recordRejected,
  getMiner,
};
