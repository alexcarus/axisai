"use strict";

const { clamp } = require("./util");
const { ARCHITECTURE_BOUNDS } = require("./references");

/**
 * training_step scoring — validates that the reported loss delta is consistent
 * with a real optimisation step for the declared model architecture.
 *
 * Expected output_data:
 *   {
 *     architecture: "transformer" | "cnn" | "mlp" | "lstm" | ...,
 *     loss_before: number,
 *     loss_after: number,
 *     step?: number
 *   }
 *
 * A submission is rewarded when loss strictly decreases by an amount within the
 * architecture's plausible per-step bounds. Implausible jumps (negative deltas
 * or deltas larger than physically reasonable for one step) are penalised as
 * likely fabricated.
 *
 * @returns {{ quality: number, details: object }}
 */
function scoreTrainingStep(parsed) {
  const arch = String(parsed.architecture || "default").toLowerCase();
  const bounds = ARCHITECTURE_BOUNDS[arch] || ARCHITECTURE_BOUNDS.default;

  const before = Number(parsed.loss_before);
  const after = Number(parsed.loss_after);

  if (!Number.isFinite(before) || !Number.isFinite(after)) {
    return { quality: 0, details: { reason: "loss values missing or non-numeric", arch } };
  }
  if (before < 0 || after < 0 || before > bounds.maxLoss) {
    return { quality: 0, details: { reason: "loss out of plausible range", arch, before, after } };
  }

  const delta = before - after; // positive = improvement

  if (delta <= bounds.minDelta) {
    // No improvement (or loss increased) — not a productive step.
    return { quality: 0, details: { reason: "no loss improvement", arch, delta } };
  }
  if (delta > bounds.maxDelta) {
    // Implausibly large single-step improvement — likely fabricated.
    return { quality: 0.1, details: { reason: "implausible loss delta", arch, delta } };
  }

  // Quality scales with the relative improvement within the valid band.
  const quality = clamp(delta / bounds.maxDelta);
  return {
    quality,
    details: { method: "loss_delta", arch, before, after, delta, bounds },
  };
}

module.exports = { scoreTrainingStep };
