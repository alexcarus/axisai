"use strict";

/**
 * AXIS AI — marketing quality benchmark (deterministic, no API).
 *
 * Rates a caption 0..1 and hard-fails obviously broken output, so nothing junk
 * is ever published. This is the same philosophy as the protocol's key-free
 * PoAIW scoring: a re-runnable, auditable, model-free check — no LLM judge, no
 * API cost, no non-determinism. Raise the threshold to be stricter.
 *
 * Extension point: swap/extend `score()` with a task-graded benchmark (e.g. a
 * click-through or engagement model) if you later want a learned signal — the
 * gate interface ({ pass, score, reasons }) stays the same.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "is", "are",
  "it", "you", "your", "no", "not", "that", "this", "with", "by", "so", "be",
]);

// A caption is expected to invite action. Any one of these counts as a CTA.
const CTA_RE =
  /\b(mine|start|try|join|read|learn|explore|get started|link in bio|see how|discover|earn)\b/i;

// Substrings that never appear in legitimate copy (template/serialisation leaks).
const HARD_FAIL_SUBSTRINGS = ["{", "}", "[object", "lorem ipsum"];
// Code-leak artifacts matched as WHOLE WORDS, so legit words that merely contain
// them don't trip the gate (e.g. "financial" contains "nan", "annul" → "null").
const HARD_FAIL_WORDS = ["undefined", "null", "nan", "todo", "fixme"];

const MIN_LEN = 60;
const MAX_LEN = 2200; // Instagram caption hard limit
const MIN_TAGS = 5;
const MAX_TAGS = 15;

/** Splits a caption into the words that carry meaning (excludes hashtags). */
function contentWords(caption) {
  return caption
    .replace(/#[a-z0-9_]+/gi, " ")
    .toLowerCase()
    .match(/[a-z0-9']+/g) || [];
}

/**
 * Scores a caption. Returns { pass, score, reasons, checks }.
 *
 * @param {string} caption
 * @param {number} [threshold=0.75] Minimum score to pass (in addition to no hard fails).
 */
function score(caption, threshold = 0.75) {
  const reasons = [];
  const text = String(caption || "");
  const lower = text.toLowerCase();

  // -------- Hard fails (any one blocks publishing regardless of score) --------
  const hardFails = [];
  for (const tok of HARD_FAIL_SUBSTRINGS) {
    if (lower.includes(tok)) hardFails.push(`contains "${tok}"`);
  }
  for (const w of HARD_FAIL_WORDS) {
    if (new RegExp(`\\b${w}\\b`, "i").test(text)) hardFails.push(`contains "${w}"`);
  }
  if (text.trim().length < MIN_LEN) hardFails.push(`too short (<${MIN_LEN} chars)`);
  if (text.length > MAX_LEN) hardFails.push(`too long (>${MAX_LEN} chars)`);

  const tags = text.match(/#[a-z0-9_]+/gi) || [];
  if (tags.length < MIN_TAGS) hardFails.push(`too few hashtags (<${MIN_TAGS})`);
  if (tags.length > MAX_TAGS) hardFails.push(`too many hashtags (>${MAX_TAGS})`);

  // -------- Weighted quality signals --------
  const checks = {};

  // Hook: a punchy first line (present, not too long).
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) || "";
  checks.hook = firstLine.trim().length > 0 && firstLine.length <= 90 ? 1 : 0;

  // Call to action present.
  checks.cta = CTA_RE.test(text) ? 1 : 0;

  // Hashtags well-formed and in range.
  const wellFormedTags = tags.every((t) => /^#[a-z0-9_]{2,30}$/i.test(t));
  checks.hashtags =
    tags.length >= MIN_TAGS && tags.length <= MAX_TAGS && wellFormedTags ? 1 : 0;

  // On-brand: mentions AXIS.
  checks.brand = /\baxis\b/i.test(text) ? 1 : 0;

  // Structure: a caption reads better with a couple of line breaks.
  checks.structure = (text.match(/\n/g) || []).length >= 2 ? 1 : 0;

  // No spammy repetition: no non-stopword content word used more than 4 times.
  const words = contentWords(text);
  const freq = new Map();
  let maxRepeat = 0;
  for (const w of words) {
    if (STOPWORDS.has(w) || w.length < 3) continue;
    const c = (freq.get(w) || 0) + 1;
    freq.set(w, c);
    if (c > maxRepeat) maxRepeat = c;
  }
  checks.noRepetition = maxRepeat <= 4 ? 1 : 0;

  // Readability: enough real words, not a single wall of text.
  checks.readable = words.length >= 12 ? 1 : 0;

  const weights = {
    hook: 0.15,
    cta: 0.2,
    hashtags: 0.2,
    brand: 0.15,
    structure: 0.1,
    noRepetition: 0.1,
    readable: 0.1,
  };
  let s = 0;
  for (const k of Object.keys(weights)) s += weights[k] * (checks[k] || 0);

  for (const k of Object.keys(checks)) {
    if (!checks[k]) reasons.push(`weak: ${k}`);
  }
  for (const hf of hardFails) reasons.push(`FAIL: ${hf}`);

  const pass = hardFails.length === 0 && s >= threshold;
  return { pass, score: Number(s.toFixed(3)), reasons, checks, hardFails };
}

module.exports = { score, MIN_LEN, MAX_LEN, MIN_TAGS, MAX_TAGS };
