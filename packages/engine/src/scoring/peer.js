"use strict";

const { clamp } = require("./util");

/**
 * peer_validation scoring — consistency of a miner's rating against the majority
 * peer rating for the same target output.
 *
 * Expected output_data:
 *   { target_submission: string, rating: number (1..5) }
 *
 * `peerContext.targetRatings` is an array of prior peer ratings for the same
 * target. Quality is high when the submitted rating is close to the peer
 * consensus (majority/mean) and low when it deviates sharply — discouraging
 * collusive or adversarial scoring.
 *
 * @returns {{ quality: number, details: object }}
 */
function scorePeerValidation(parsed, peerContext = {}) {
  const rating = Number(parsed.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return { quality: 0, details: { reason: "rating out of range (1..5)" } };
  }

  const peerRatings = (peerContext.targetRatings || []).map(Number).filter(Number.isFinite);
  if (peerRatings.length === 0) {
    // First reviewer of this target — provisional neutral-confidence score.
    return { quality: 0.6, details: { method: "provisional_first_reviewer", rating } };
  }

  const mean = peerRatings.reduce((a, b) => a + b, 0) / peerRatings.length;
  const deviation = Math.abs(rating - mean);
  // Max possible deviation on a 1..5 scale is 4.
  const consistency = clamp(1 - deviation / 4);

  return {
    quality: consistency,
    details: {
      method: "consensus_consistency",
      rating,
      peerMean: mean,
      deviation,
      peerCount: peerRatings.length,
    },
  };
}

module.exports = { scorePeerValidation };
