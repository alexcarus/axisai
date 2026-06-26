"use strict";

const { embedText } = require("./util");

/**
 * Reference material for deterministic scoring. In production these would be
 * curated benchmark sets; here they are concrete, shipped reference corpora and
 * distributions so every scoring function has a real baseline to compare to.
 */

// Reference text snippets representing high-quality, coherent outputs per topic.
const TEXT_REFERENCE_CORPUS = [
  "the model produced a clear coherent and well structured natural language response",
  "artificial intelligence computation is verified on chain and rewarded with axis tokens",
  "the inference output is grammatically correct semantically consistent and relevant",
  "proof of ai work transforms computation into a mineable digital commodity",
  "the answer is accurate concise and directly addresses the input prompt",
];

const TEXT_REFERENCE_EMBEDDINGS = TEXT_REFERENCE_CORPUS.map((t) => embedText(t));

// Reference numeric distribution for synthetic-data scoring: a standard normal
// sampled into a fixed reference histogram domain [-4, 4].
const SYNTHETIC_REFERENCE = (() => {
  // Generate a deterministic gaussian reference via Box-Muller with a fixed seed.
  const samples = [];
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 5000; i++) {
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    samples.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
  }
  return { samples, min: -4, max: 4, bins: 32 };
})();

// Expected loss-delta bounds per declared model architecture (training_step).
// A valid training step must reduce loss within the architecture's plausible
// per-step range.
const ARCHITECTURE_BOUNDS = {
  mlp: { minDelta: 0.0, maxDelta: 0.5, maxLoss: 10 },
  cnn: { minDelta: 0.0, maxDelta: 0.4, maxLoss: 8 },
  transformer: { minDelta: 0.0, maxDelta: 0.3, maxLoss: 12 },
  lstm: { minDelta: 0.0, maxDelta: 0.45, maxLoss: 10 },
  default: { minDelta: 0.0, maxDelta: 0.5, maxLoss: 15 },
};

module.exports = {
  TEXT_REFERENCE_CORPUS,
  TEXT_REFERENCE_EMBEDDINGS,
  SYNTHETIC_REFERENCE,
  ARCHITECTURE_BOUNDS,
};
