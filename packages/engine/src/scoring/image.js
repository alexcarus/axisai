"use strict";

const { ssim, clamp, embedText, cosineSimilarity } = require("./util");

/**
 * inference_image scoring — SSIM against a reference image, with a CLIP-style
 * semantic-similarity fallback when raw pixels are unavailable.
 *
 * Accepted output_data shapes:
 *   { pixels: number[], reference: number[] }   -> grayscale arrays (0..255)
 *   { output: number[], reference: number[] }   -> same
 *   { caption: string, reference_caption: str } -> semantic fallback
 *
 * @returns {{ quality: number, details: object }}
 */
function scoreInferenceImage(parsed) {
  const out = parsed.pixels || parsed.output || parsed.image;
  const ref = parsed.reference || parsed.reference_pixels;

  if (Array.isArray(out) && Array.isArray(ref) && out.length > 0) {
    const score = ssim(out.map(Number), ref.map(Number));
    // SSIM is in [-1,1]; map to [0,1].
    const quality = clamp((score + 1) / 2);
    return { quality, details: { method: "ssim", ssim: score, pixels: out.length } };
  }

  // CLIP-style semantic fallback: compare generated caption to reference caption.
  if (parsed.caption && parsed.reference_caption) {
    const sim = cosineSimilarity(
      embedText(parsed.caption),
      embedText(parsed.reference_caption)
    );
    const quality = clamp((sim + 1) / 2);
    return { quality, details: { method: "clip_caption", cosine: sim } };
  }

  return { quality: 0, details: { reason: "no comparable image data provided" } };
}

module.exports = { scoreInferenceImage };
