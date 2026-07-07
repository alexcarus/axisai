"use strict";

const config = require("./config");

/**
 * The compute market serves two kinds of tiers:
 *   - "operator": run instantly by the market's own free Cloudflare Workers AI
 *                 backend (no miner needed), priced at tokenPricing.discount
 *                 (50% off) of a cheap model's cost.
 *   - "miner":    run by DISTRIBUTED MINERS on their OWN Anthropic/OpenAI key
 *                 (bin/axis-serve.mjs). Priced at premiumDiscount (30% off the
 *                 provider's real list price) so buyers pay 70% of what Claude /
 *                 OpenAI would charge. If no miner is online, the operator serves
 *                 `fallbackModel` on Cloudflare so a premium order never gets stuck
 *                 (it degrades to a free model rather than hanging).
 *
 * `ref` = the benchmarked provider's real cost per 1M OUTPUT tokens (USD), used to
 * derive the AXIS price. Override the whole list with COMPUTE_CATALOG (JSON), and
 * nudge any single price with PRICE_<ID>_AXIS.
 */
const CATALOG = [
  { id: "pro", band: "flagship", serve: "miner", ref: 75, label: "Flagship — Claude Opus / GPT (miner-run)", fallbackModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  { id: "balanced", band: "high", serve: "miner", ref: 15, label: "High — Claude Sonnet / GPT-4o (miner-run)", fallbackModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
  { id: "standard", band: "mid", serve: "operator", ref: 5, label: "Standard — Llama 3.1 8B (instant)", model: "@cf/meta/llama-3.1-8b-instruct-fp8" },
  { id: "fast", band: "cheap", serve: "operator", ref: 0.6, label: "Fast — Llama 3.2 3B (instant)", model: "@cf/meta/llama-3.2-3b-instruct" },
];

/** Parses COMPUTE_CATALOG (JSON) if set and valid, else the built-in tiers. */
function catalogTiers() {
  const raw = (process.env.COMPUTE_CATALOG || "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (_) {
      // eslint-disable-next-line no-console
      console.warn("[models] COMPUTE_CATALOG is not valid JSON — using built-in tiers");
    }
  }
  return CATALOG;
}

/**
 * Derives the AXIS price from the benchmarked provider's real cost:
 *   price_axis = max(minAxis, round( refUsdPer1M/1e6 * budgetTokens * discount / axisUsd ))
 * i.e. the buyer pays `discount` of what the same token budget costs at the
 * reference provider (0.5 for operator tiers, 0.7 for premium/miner tiers).
 */
function computePriceAxis(refUsdPer1M, discount) {
  const tp = config.tokenPricing;
  const ref = Number(refUsdPer1M);
  const d = discount != null ? discount : tp.discount;
  if (!ref || ref <= 0) return String(tp.minAxis);
  const usd = (ref / 1e6) * tp.budgetTokens * d;
  const axis = usd / (tp.axisUsd > 0 ? tp.axisUsd : 0.0062);
  return String(Math.max(tp.minAxis, Math.round(axis)));
}

/** The OPERATOR backend that serves the instant (cheap) tiers + premium fallbacks. */
function provider() {
  if (config.cloudflare.accountId && config.cloudflare.apiToken) return "cloudflare";
  if (config.omniroute.url) return "omniroute";
  if (config.ai.anthropicKey) return "anthropic";
  if (config.ai.openaiKey) return "openai";
  return null;
}

/** Optional per-id price override, e.g. PRICE_PRO_AXIS. */
function priceFor(id, fallback) {
  const env = process.env[`PRICE_${String(id).toUpperCase()}_AXIS`];
  return env != null && env !== "" ? env : fallback;
}

/** The public, priced catalog (operator + miner tiers). */
function catalog() {
  const tp = config.tokenPricing;
  return catalogTiers().map((t) => {
    const isMiner = t.serve === "miner";
    const discount = isMiner ? tp.premiumDiscount : tp.discount;
    return {
      id: t.id,
      band: t.band,
      label: t.label,
      serve: t.serve || "operator",
      // Operator tiers run on the market's Cloudflare backend; miner tiers are run
      // by the miner's own key (the miner maps the tier id to their model).
      provider: isMiner ? "miner" : "cloudflare",
      model: isMiner ? null : t.model,
      fallback_model: t.fallbackModel || null,
      output_tokens: tp.budgetTokens,
      price_axis: priceFor(t.id, t.price_axis != null ? t.price_axis : computePriceAxis(t.ref, discount)),
    };
  });
}

function getTier(id) {
  return catalog().find((t) => t.id === id) || null;
}

module.exports = { catalog, getTier, provider };
