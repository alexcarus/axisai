"use strict";

const { query } = require("../db/pool");

/**
 * Reputation system. Every wallet has a provider_score and a requester_score,
 * recomputed from the underlying counters whenever they change.
 *
 *   provider_score  = weighted avg of:
 *       - job completion rate          (weight 0.4)
 *       - verification pass rate       (weight 0.4)
 *       - delivery-time factor         (weight 0.2)  (faster = higher)
 *   requester_score = weighted avg of:
 *       - payment reliability          (weight 0.7)
 *       - (1 - dispute rate)           (weight 0.3)
 *
 * Scores are in [0,1].
 */

async function ensure(wallet) {
  await query(
    `INSERT INTO reputation (wallet) VALUES ($1) ON CONFLICT (wallet) DO NOTHING`,
    [wallet.toLowerCase()]
  );
}

function clamp(x) {
  return Math.max(0, Math.min(1, x));
}

async function recompute(wallet) {
  const { rows } = await query(`SELECT * FROM reputation WHERE wallet = $1`, [wallet.toLowerCase()]);
  const r = rows[0];
  if (!r) return;

  const totalJobs = r.jobs_completed + r.jobs_failed;
  const completionRate = totalJobs > 0 ? r.jobs_completed / totalJobs : 0;

  const totalVer = r.verifications_passed + r.verifications_failed;
  const passRate = totalVer > 0 ? r.verifications_passed / totalVer : 0;

  // Delivery factor: 1.0 at instant delivery, decaying with average seconds.
  const avgDelivery = r.delivery_samples > 0 ? r.total_delivery_secs / r.delivery_samples : 0;
  const deliveryFactor = clamp(1 - avgDelivery / 1800); // 30-min reference

  const providerScore = clamp(0.4 * completionRate + 0.4 * passRate + 0.2 * deliveryFactor);

  const totalPayObligations = r.payments_made + r.disputes;
  const paymentReliability = totalPayObligations > 0 ? r.payments_made / totalPayObligations : (r.payments_made > 0 ? 1 : 0);
  const disputeRate = totalPayObligations > 0 ? r.disputes / totalPayObligations : 0;
  const requesterScore = clamp(0.7 * paymentReliability + 0.3 * (1 - disputeRate));

  await query(
    `UPDATE reputation SET provider_score=$2, requester_score=$3, updated_at=now() WHERE wallet=$1`,
    [wallet.toLowerCase(), providerScore, requesterScore]
  );
}

// ---- Event hooks ---- //

async function onJobCompleted(provider, deliverySeconds, verificationPassed) {
  await ensure(provider);
  await query(
    `UPDATE reputation
       SET jobs_completed = jobs_completed + 1,
           verifications_passed = verifications_passed + $2,
           verifications_failed = verifications_failed + $3,
           total_delivery_secs = total_delivery_secs + $4,
           delivery_samples = delivery_samples + 1
     WHERE wallet = $1`,
    [provider.toLowerCase(), verificationPassed ? 1 : 0, verificationPassed ? 0 : 1, Math.max(0, Math.floor(deliverySeconds || 0))]
  );
  await recompute(provider);
}

async function onJobFailed(provider, verificationFailed) {
  await ensure(provider);
  await query(
    `UPDATE reputation
       SET jobs_failed = jobs_failed + 1,
           verifications_failed = verifications_failed + $2
     WHERE wallet = $1`,
    [provider.toLowerCase(), verificationFailed ? 1 : 0]
  );
  await recompute(provider);
}

async function onRequesterPayment(requester) {
  await ensure(requester);
  await query(`UPDATE reputation SET payments_made = payments_made + 1 WHERE wallet = $1`, [
    requester.toLowerCase(),
  ]);
  await recompute(requester);
}

async function onRequesterDispute(requester) {
  await ensure(requester);
  await query(`UPDATE reputation SET disputes = disputes + 1 WHERE wallet = $1`, [requester.toLowerCase()]);
  await recompute(requester);
}

async function get(wallet) {
  await ensure(wallet);
  const { rows } = await query(`SELECT * FROM reputation WHERE wallet = $1`, [wallet.toLowerCase()]);
  return rows[0];
}

module.exports = {
  ensure,
  recompute,
  onJobCompleted,
  onJobFailed,
  onRequesterPayment,
  onRequesterDispute,
  get,
};
