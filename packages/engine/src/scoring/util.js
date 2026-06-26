"use strict";

/**
 * Deterministic numeric primitives shared by the scoring functions. All are
 * real, self-contained implementations — no external model calls — so the
 * engine scores reproducibly and offline.
 */

const EMBED_DIM = 256;

/**
 * Tokenises text into lowercase word tokens.
 */
function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * FNV-1a hash of a string into a non-negative 32-bit integer. Used to project
 * tokens into a fixed-dimensional embedding space (the hashing trick).
 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Computes a deterministic bag-of-words + bigram embedding for text via the
 * hashing trick, with sublinear term-frequency weighting and L2 normalisation.
 * This is a genuine vector-space embedding suitable for cosine similarity.
 */
function embedText(text) {
  const tokens = tokenize(text);
  const vec = new Float64Array(EMBED_DIM);
  if (tokens.length === 0) return vec;

  const counts = new Map();
  const bump = (key) => counts.set(key, (counts.get(key) || 0) + 1);
  for (let i = 0; i < tokens.length; i++) {
    bump(tokens[i]);
    if (i + 1 < tokens.length) bump(tokens[i] + "_" + tokens[i + 1]); // bigram
  }

  for (const [term, tf] of counts.entries()) {
    const idx = fnv1a(term) % EMBED_DIM;
    const sign = fnv1a("sign:" + term) % 2 === 0 ? 1 : -1; // signed hashing
    vec[idx] += sign * (1 + Math.log(tf));
  }

  // L2 normalise.
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return vec;
}

/**
 * Cosine similarity of two equal-length numeric vectors. Returns a value in
 * [-1, 1].
 */
function cosineSimilarity(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Builds a normalised probability histogram of numeric samples over `bins`
 * equal-width buckets spanning [min, max]. Laplace-smoothed so no bucket is 0.
 */
function histogram(samples, bins, min, max) {
  const h = new Array(bins).fill(1); // Laplace smoothing
  const span = max - min || 1;
  for (const x of samples) {
    let idx = Math.floor(((x - min) / span) * bins);
    if (idx < 0) idx = 0;
    if (idx >= bins) idx = bins - 1;
    h[idx] += 1;
  }
  const total = h.reduce((a, b) => a + b, 0);
  return h.map((c) => c / total);
}

/**
 * Kullback-Leibler divergence D_KL(P || Q) for two discrete distributions of
 * equal length (both assumed strictly positive after smoothing).
 */
function klDivergence(p, q) {
  let sum = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > 0) sum += p[i] * Math.log(p[i] / q[i]);
  }
  return sum;
}

/**
 * Structural Similarity Index (SSIM) between two equal-length grayscale pixel
 * arrays (values 0..255). Full single-window implementation of the SSIM formula
 * using global means, variances and covariance.
 */
function ssim(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let muA = 0;
  let muB = 0;
  for (let i = 0; i < n; i++) {
    muA += a[i];
    muB += b[i];
  }
  muA /= n;
  muB /= n;

  let varA = 0;
  let varB = 0;
  let cov = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - muA;
    const db = b[i] - muB;
    varA += da * da;
    varB += db * db;
    cov += da * db;
  }
  varA /= n - 1 || 1;
  varB /= n - 1 || 1;
  cov /= n - 1 || 1;

  const L = 255;
  const c1 = (0.01 * L) ** 2;
  const c2 = (0.03 * L) ** 2;
  const numerator = (2 * muA * muB + c1) * (2 * cov + c2);
  const denominator = (muA * muA + muB * muB + c1) * (varA + varB + c2);
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Clamps x into [lo, hi]. */
function clamp(x, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, x));
}

module.exports = {
  EMBED_DIM,
  tokenize,
  fnv1a,
  embedText,
  cosineSimilarity,
  histogram,
  klDivergence,
  ssim,
  clamp,
};
