"use strict";

/**
 * Workload (`W`) unit mapping. `W` = verified workload units, derived from the
 * work type and the size of the submitted data. One "Minimum Work Unit"
 * (whitepaper 4.2: 1 inference / 1 training step / 1 TX) equals a base value of
 * 1; larger payloads scale W upward in defined, bounded increments.
 */

const BASE_UNITS = {
  inference_text: 1,
  inference_image: 1,
  inference_audio: 1,
  training_step: 1,
  dataset_labeling: 1,
  synthetic_data_generation: 1,
  peer_validation: 1,
};

// How much output data maps to one additional workload unit, per work type.
const SIZE_DIVISOR = {
  inference_text: 280, // ~one extra unit per 280 chars of generated text
  inference_image: 4096, // pixels per extra unit
  inference_audio: 1024, // frames per extra unit
  training_step: 1, // each declared step is one unit (scaled by `steps`)
  dataset_labeling: 1, // one unit per labeled item
  synthetic_data_generation: 50, // samples per extra unit
  peer_validation: 1, // one validation = one unit
};

const MAX_WORKLOAD = 1000; // safety cap per submission

/**
 * Computes the verified workload `W` for a submission.
 *
 * @param {string} workType
 * @param {any} parsed Parsed output_data.
 * @returns {number} Integer workload units >= 1.
 */
function computeWorkload(workType, parsed) {
  const base = BASE_UNITS[workType] || 1;
  const divisor = SIZE_DIVISOR[workType] || 1;
  let sizeUnits = 0;

  switch (workType) {
    case "inference_text": {
      const text =
        typeof parsed === "string" ? parsed : parsed.text || parsed.output || "";
      sizeUnits = Math.floor(String(text).length / divisor);
      break;
    }
    case "inference_image": {
      const px = parsed.pixels || parsed.output || parsed.image || [];
      sizeUnits = Math.floor((Array.isArray(px) ? px.length : 0) / divisor);
      break;
    }
    case "inference_audio": {
      const frames = parsed.mfcc || parsed.samples || parsed.output || [];
      sizeUnits = Math.floor((Array.isArray(frames) ? frames.length : 0) / divisor);
      break;
    }
    case "training_step": {
      sizeUnits = Math.max(0, (Number(parsed.steps) || 1) - 1);
      break;
    }
    case "dataset_labeling": {
      const labels = parsed.labels || {};
      sizeUnits = Math.max(0, Object.keys(labels).length - 1);
      break;
    }
    case "synthetic_data_generation": {
      const samples = parsed.samples || parsed.output || [];
      sizeUnits = Math.floor((Array.isArray(samples) ? samples.length : 0) / divisor);
      break;
    }
    case "peer_validation":
    default:
      sizeUnits = 0;
  }

  const w = base + sizeUnits;
  return Math.max(1, Math.min(MAX_WORKLOAD, w));
}

module.exports = { computeWorkload, BASE_UNITS, SIZE_DIVISOR, MAX_WORKLOAD };
