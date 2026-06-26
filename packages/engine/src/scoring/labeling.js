"use strict";

const { clamp } = require("./util");

/**
 * dataset_labeling scoring — agreement rate against peer labels in the same
 * batch.
 *
 * Expected output_data:
 *   { batch_id: string, labels: { [itemId: string]: string|number } }
 *
 * `peerContext.batchLabels` provides, for each item in the batch, the
 * distribution of labels submitted by peers. Quality is the mean agreement of
 * this submission's labels with the per-item majority peer label. When no peer
 * labels exist yet (first labeler of a batch), the submission is provisionally
 * scored on self-consistency / completeness and later reinforced by peers.
 *
 * @returns {{ quality: number, details: object }}
 */
function scoreDatasetLabeling(parsed, peerContext = {}) {
  const labels = parsed.labels || {};
  const items = Object.keys(labels);
  if (items.length === 0) {
    return { quality: 0, details: { reason: "no labels submitted" } };
  }

  const batchLabels = peerContext.batchLabels || {};
  let agreements = 0;
  let comparable = 0;

  for (const item of items) {
    const peerDist = batchLabels[item];
    if (!peerDist) continue;
    comparable += 1;
    // Determine the majority peer label for this item.
    let majority = null;
    let majorityCount = -1;
    for (const [label, count] of Object.entries(peerDist)) {
      if (count > majorityCount) {
        majorityCount = count;
        majority = label;
      }
    }
    if (String(labels[item]) === String(majority)) agreements += 1;
  }

  if (comparable === 0) {
    // No peer overlap yet — provisional completeness score.
    const completeness = clamp(items.length / 10);
    return {
      quality: clamp(0.5 + 0.2 * completeness),
      details: { method: "provisional_completeness", labeled: items.length },
    };
  }

  const agreementRate = agreements / comparable;
  return {
    quality: clamp(agreementRate),
    details: { method: "peer_agreement", agreements, comparable, agreementRate },
  };
}

module.exports = { scoreDatasetLabeling };
