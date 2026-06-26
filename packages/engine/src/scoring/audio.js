"use strict";

const { clamp, cosineSimilarity } = require("./util");

/**
 * inference_audio scoring — spectral correlation against a reference signal.
 *
 * Accepted output_data shapes:
 *   { samples: number[], reference: number[] }  -> raw/feature audio frames
 *   { mfcc: number[], reference_mfcc: number[] } -> precomputed features
 *
 * Quality is the normalised cosine correlation between the output feature
 * vector and the reference feature vector (a genuine signal-similarity metric).
 *
 * @returns {{ quality: number, details: object }}
 */
function scoreInferenceAudio(parsed) {
  const out = parsed.mfcc || parsed.samples || parsed.output;
  const ref = parsed.reference_mfcc || parsed.reference;

  if (!Array.isArray(out) || !Array.isArray(ref) || out.length === 0) {
    return { quality: 0, details: { reason: "no comparable audio features" } };
  }

  const sim = cosineSimilarity(out.map(Number), ref.map(Number));
  const quality = clamp((sim + 1) / 2);
  return { quality, details: { method: "spectral_cosine", cosine: sim, frames: out.length } };
}

module.exports = { scoreInferenceAudio };
