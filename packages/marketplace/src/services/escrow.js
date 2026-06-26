"use strict";

const { query } = require("../db/pool");
const chain = require("../chain/escrow");
const config = require("../config");
const logger = require("../logger");

/**
 * Escrow lifecycle service. The PostgreSQL `escrows` table is the authoritative
 * record; on-chain settlement is mirrored when ESCROW_ONCHAIN=true. Every state
 * change writes an `escrow_events` row (and emits the corresponding contract
 * event on-chain when enabled).
 */

async function recordEvent(escrowId, jobId, type, amount, txHash) {
  await query(
    `INSERT INTO escrow_events (escrow_id, job_id, event_type, amount_axis, tx_hash)
     VALUES ($1,$2,$3,$4,$5)`,
    [escrowId, jobId, type, amount, txHash]
  );
}

/**
 * Locks an escrow for a job. Records a 'locked' escrow + event.
 */
async function lock(jobId, requester, provider, amountAxis) {
  const timeoutAt = new Date(Date.now() + config.jobs.timeoutSeconds * 1000);
  const { rows } = await query(
    `INSERT INTO escrows (job_id, requester_wallet, provider_wallet, amount_axis, status, timeout_at)
     VALUES ($1,$2,$3,$4,'locked',$5) RETURNING *`,
    [jobId, requester.toLowerCase(), provider.toLowerCase(), amountAxis, timeoutAt]
  );
  const escrow = rows[0];
  await recordEvent(escrow.id, jobId, "locked", amountAxis, null);
  logger.info("escrow locked", { jobId, escrowId: escrow.id, amountAxis });
  return escrow;
}

async function _getActive(jobId) {
  const { rows } = await query(
    `SELECT * FROM escrows WHERE job_id = $1 AND status = 'locked' ORDER BY created_at DESC LIMIT 1`,
    [jobId]
  );
  return rows[0] || null;
}

/**
 * Releases the escrow to the provider on verified delivery.
 */
async function release(jobId) {
  const escrow = await _getActive(jobId);
  if (!escrow) return null;
  const { txHash } = await chain.release(jobId);
  await query(`UPDATE escrows SET status='released', settled_at=now(), tx_hash=COALESCE($2,tx_hash) WHERE id=$1`, [
    escrow.id,
    txHash,
  ]);
  await recordEvent(escrow.id, jobId, "released", escrow.amount_axis, txHash);
  logger.info("escrow released to provider", { jobId, provider: escrow.provider_wallet, txHash });
  return { escrow, txHash };
}

/**
 * Refunds the escrow to the requester on timeout / failure.
 */
async function refund(jobId, reason = "refund") {
  const escrow = await _getActive(jobId);
  if (!escrow) return null;
  const { txHash } = await chain.refund(jobId);
  await query(`UPDATE escrows SET status='refunded', settled_at=now(), tx_hash=COALESCE($2,tx_hash) WHERE id=$1`, [
    escrow.id,
    txHash,
  ]);
  await recordEvent(escrow.id, jobId, reason, escrow.amount_axis, txHash);
  logger.info("escrow refunded to requester", { jobId, requester: escrow.requester_wallet, reason, txHash });
  return { escrow, txHash };
}

/**
 * Refunds the requester and flags the provider for fraud.
 */
async function flagFraud(jobId) {
  const escrow = await _getActive(jobId);
  if (!escrow) return null;
  const { txHash } = await chain.flagFraud(jobId);
  await query(`UPDATE escrows SET status='refunded', settled_at=now(), tx_hash=COALESCE($2,tx_hash) WHERE id=$1`, [
    escrow.id,
    txHash,
  ]);
  await recordEvent(escrow.id, jobId, "fraud_refund", escrow.amount_axis, txHash);
  logger.warn("escrow fraud — provider flagged, requester refunded", {
    jobId,
    provider: escrow.provider_wallet,
    txHash,
  });
  return { escrow, txHash };
}

module.exports = { lock, release, refund, flagFraud, recordEvent };
