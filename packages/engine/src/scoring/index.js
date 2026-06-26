"use strict";

const { scoreInferenceText } = require("./text");
const { scoreInferenceImage } = require("./image");
const { scoreInferenceAudio } = require("./audio");
const { scoreTrainingStep } = require("./training");
const { scoreDatasetLabeling } = require("./labeling");
const { scoreSyntheticData } = require("./synthetic");
const { scorePeerValidation } = require("./peer");

/**
 * Canonical PoAIW work types (whitepaper section 5.1).
 */
const WORK_TYPES = [
  "inference_text",
  "inference_image",
  "inference_audio",
  "training_step",
  "dataset_labeling",
  "synthetic_data_generation",
  "peer_validation",
];

/**
 * Dispatches a parsed output to the work-type-specific scoring function.
 *
 * @param {string} workType One of WORK_TYPES.
 * @param {any} parsed Parsed output_data.
 * @param {object} peerContext Cross-checking context (batch labels, peer ratings).
 * @returns {{ quality: number, details: object }} quality in [0,1].
 */
function scoreSubmission(workType, parsed, peerContext = {}) {
  switch (workType) {
    case "inference_text":
      return scoreInferenceText(parsed);
    case "inference_image":
      return scoreInferenceImage(parsed);
    case "inference_audio":
      return scoreInferenceAudio(parsed);
    case "training_step":
      return scoreTrainingStep(parsed);
    case "dataset_labeling":
      return scoreDatasetLabeling(parsed, peerContext);
    case "synthetic_data_generation":
      return scoreSyntheticData(parsed);
    case "peer_validation":
      return scorePeerValidation(parsed, peerContext);
    default:
      return { quality: 0, details: { reason: `unknown work_type: ${workType}` } };
  }
}

function isValidWorkType(workType) {
  return WORK_TYPES.includes(workType);
}

module.exports = { WORK_TYPES, scoreSubmission, isValidWorkType };
