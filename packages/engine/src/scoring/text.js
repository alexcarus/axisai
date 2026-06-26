"use strict";

const { embedText, cosineSimilarity, clamp } = require("./util");
const { TEXT_REFERENCE_EMBEDDINGS } = require("./references");

/**
 * inference_text scoring — semantic coherence via cosine similarity against a
 * reference embedding set.
 *
 * The output text is embedded and compared to each reference embedding; the
 * maximum cosine similarity is taken as the coherence/relevance signal. A short
 * length-adequacy factor discourages trivially short answers.
 *
 * @returns {{ quality: number, details: object }}
 */
function scoreInferenceText(parsed) {
  const text =
    typeof parsed === "string"
      ? parsed
      : parsed.text || parsed.output || parsed.response || "";

  if (!text || text.trim().length === 0) {
    return { quality: 0, details: { reason: "empty text output" } };
  }

  const emb = embedText(text);
  let best = -1;
  let bestIdx = -1;
  TEXT_REFERENCE_EMBEDDINGS.forEach((ref, i) => {
    const sim = cosineSimilarity(emb, ref);
    if (sim > best) {
      best = sim;
      bestIdx = i;
    }
  });

  // Cosine in [-1,1] -> coherence in [0,1].
  const coherence = clamp((best + 1) / 2);
  // Length adequacy: saturates at ~20 tokens.
  const tokenCount = text.trim().split(/\s+/).length;
  const lengthFactor = clamp(tokenCount / 20);

  const quality = clamp(0.7 * coherence + 0.3 * lengthFactor);

  return {
    quality,
    details: {
      maxCosineSimilarity: best,
      coherence,
      lengthFactor,
      matchedReference: bestIdx,
      tokenCount,
    },
  };
}

module.exports = { scoreInferenceText };
