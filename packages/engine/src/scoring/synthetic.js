"use strict";

const { histogram, klDivergence, clamp } = require("./util");
const { SYNTHETIC_REFERENCE } = require("./references");

/**
 * synthetic_data_generation scoring — statistical distribution similarity via
 * KL divergence against a reference distribution.
 *
 * Expected output_data:
 *   { samples: number[] }            -> generated numeric samples
 *   { samples: number[], reference: number[] } -> custom reference allowed
 *
 * The generated samples are histogrammed over the reference domain and KL
 * divergence D_KL(P_generated || Q_reference) is computed. Lower divergence =
 * higher quality. Quality = exp(-KL) maps [0, inf) -> (0, 1].
 *
 * @returns {{ quality: number, details: object }}
 */
function scoreSyntheticData(parsed) {
  const samples = (parsed.samples || parsed.output || []).map(Number).filter(Number.isFinite);
  if (samples.length < 5) {
    return { quality: 0, details: { reason: "insufficient samples", count: samples.length } };
  }

  let refSamples = SYNTHETIC_REFERENCE.samples;
  let min = SYNTHETIC_REFERENCE.min;
  let max = SYNTHETIC_REFERENCE.max;
  const bins = SYNTHETIC_REFERENCE.bins;

  if (Array.isArray(parsed.reference) && parsed.reference.length >= 5) {
    refSamples = parsed.reference.map(Number).filter(Number.isFinite);
    min = Math.min(...refSamples, ...samples);
    max = Math.max(...refSamples, ...samples);
  }

  const p = histogram(samples, bins, min, max);
  const q = histogram(refSamples, bins, min, max);
  const kl = klDivergence(p, q);

  const quality = clamp(Math.exp(-kl));
  return {
    quality,
    details: { method: "kl_divergence", kl, bins, samples: samples.length },
  };
}

module.exports = { scoreSyntheticData };
