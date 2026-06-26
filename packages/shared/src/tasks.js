"use strict";

/**
 * Task catalogue for the seven PoAIW work types (whitepaper section 5.1). Each
 * entry carries: a display label, user instructions, a typical workload (used
 * for reward estimates), and a `sample()` generator that returns a *valid*
 * output_data string which will pass the engine's scoring function — so users
 * can complete an entry-level task immediately (whitepaper 4.4).
 */

/** Deterministic-ish gaussian sample via Box-Muller. */
function gaussian() {
  const u1 = Math.max(Math.random(), 1e-9);
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const WORK_TYPES = [
  {
    id: "inference_text",
    label: "📝 Text Inference",
    typicalW: 1,
    instructions:
      "Run a text-generation/inference task and submit the generated text. " +
      "Aim for a coherent, relevant, well-structured response.",
    sample: () =>
      JSON.stringify({
        text:
          "the inference output is coherent relevant accurate and well structured natural language response",
      }),
  },
  {
    id: "inference_image",
    label: "🖼️ Image Inference",
    typicalW: 1,
    instructions:
      "Run an image inference/generation task. Submit grayscale pixel arrays " +
      "for your output and the reference for SSIM comparison.",
    sample: () => {
      const ref = Array.from({ length: 64 }, (_, i) => (i * 4) % 256);
      const out = ref.map((v) => Math.min(255, Math.max(0, v + (Math.random() < 0.2 ? 3 : 0))));
      return JSON.stringify({ pixels: out, reference: ref });
    },
  },
  {
    id: "inference_audio",
    label: "🔊 Audio Inference",
    typicalW: 1,
    instructions:
      "Run an audio inference task. Submit MFCC feature frames for your output " +
      "and the reference for spectral comparison.",
    sample: () => {
      const ref = Array.from({ length: 40 }, (_, i) => Math.sin(i / 3));
      const out = ref.map((v) => v + (Math.random() - 0.5) * 0.05);
      return JSON.stringify({ mfcc: out, reference_mfcc: ref });
    },
  },
  {
    id: "training_step",
    label: "🏋️ Training Step",
    typicalW: 1,
    instructions:
      "Perform one training/fine-tuning step. Submit the model architecture and " +
      "loss before/after. Loss must decrease within plausible bounds.",
    sample: () =>
      JSON.stringify({
        architecture: "transformer",
        loss_before: 2.0,
        loss_after: 1.85,
        steps: 1,
      }),
  },
  {
    id: "dataset_labeling",
    label: "🏷️ Dataset Labeling",
    typicalW: 1,
    instructions:
      "Label a batch of items. Submit a batch_id and a labels map. Agreement " +
      "with peer labels in the same batch drives your score.",
    sample: () =>
      JSON.stringify({
        batch_id: "batch-genesis-001",
        labels: { item1: "cat", item2: "dog", item3: "cat", item4: "bird" },
      }),
  },
  {
    id: "synthetic_data_generation",
    label: "🧪 Synthetic Data",
    typicalW: 1,
    instructions:
      "Generate synthetic samples matching the reference distribution (standard " +
      "normal). Submit a samples array; lower KL divergence scores higher.",
    sample: () => JSON.stringify({ samples: Array.from({ length: 200 }, () => gaussian()) }),
  },
  {
    id: "peer_validation",
    label: "✅ Peer Validation",
    typicalW: 1,
    instructions:
      "Validate another miner's output. Submit the target submission id and a " +
      "1–5 rating. Consistency with peer consensus scores higher.",
    sample: () =>
      JSON.stringify({ target_submission: "job-sample-target", rating: 4 }),
  },
];

const BY_ID = Object.fromEntries(WORK_TYPES.map((w) => [w.id, w]));

function getWorkType(id) {
  return BY_ID[id] || null;
}

function isValidWorkType(id) {
  return Boolean(BY_ID[id]);
}

/**
 * Estimates the reward for a work type given live network state.
 * reward ≈ baseReward × W × Q / D, with Q assumed ~1.0.
 */
function estimateReward(workTypeId, baseRewardAxis, difficulty) {
  const wt = BY_ID[workTypeId];
  if (!wt) return 0;
  const base = Number(baseRewardAxis || 0);
  const d = Number(difficulty || 1) || 1;
  return (base * wt.typicalW * 1.0) / d;
}

module.exports = { WORK_TYPES, getWorkType, isValidWorkType, estimateReward };
