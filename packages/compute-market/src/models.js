"use strict";

const config = require("./config");

// Default model per tier per provider. Better tier = more powerful model.
const DEFAULTS = {
  anthropic: {
    fast: "claude-haiku-4-5",
    balanced: "claude-sonnet-4-6",
    pro: "claude-opus-4-8",
  },
  openai: {
    fast: "gpt-4o-mini",
    balanced: "gpt-4o",
    pro: "gpt-4o",
  },
};

/**
 * Curated OmniRoute catalog — grouped into price bands from expensive to cheap.
 * OmniRoute fronts many providers behind one OpenAI-compatible endpoint, so we
 * expose a hand-picked set (not all ~hundreds) with sane AXIS prices: stronger
 * models cost more AXIS, lighter ones stay cheap. `fast`/`balanced`/`pro` are
 * kept as ids so existing clients (the website) keep working.
 *
 * Fully overridable at runtime with OMNIROUTE_CATALOG (a JSON array of
 * { id, band, label, model, price_axis }), and each price can be nudged with
 * PRICE_<ID>_AXIS. Finalize the `model` ids against `GET /v1/models` on your
 * running OmniRoute so every entry routes to a real model.
 */
// `ref` = the benchmarked provider's real cost per 1M OUTPUT tokens (USD). AXIS
// price is derived from it (see catalog()) at a discount, so every tier is a
// transparent, cheaper-than-direct deal. Prices are NOT hardcoded — they follow
// config.tokenPricing (budget × discount ÷ AXIS/USD).
const OMNIROUTE_BANDS = [
  { id: "pro", band: "flagship", label: "Flagship — top reasoning (premium)", model: "auto/best-reasoning", ref: 75 },
  { id: "opus", band: "flagship", label: "Claude Opus — frontier", model: "auto/claude-opus", ref: 75 },
  { id: "reasoning", band: "flagship", label: "Pro reasoning", model: "auto/pro-reasoning", ref: 75 },
  { id: "coding", band: "high", label: "Best coding", model: "auto/best-coding", ref: 15 },
  { id: "sonnet", band: "high", label: "Claude Sonnet — strong", model: "auto/claude-sonnet", ref: 15 },
  { id: "balanced", band: "high", label: "Balanced — strong, mid price", model: "auto/best-chat", ref: 15 },
  { id: "smart", band: "mid", label: "Smart — fast + capable", model: "auto/smart", ref: 5 },
  { id: "chat", band: "mid", label: "Chat — general purpose", model: "auto/chat", ref: 5 },
  { id: "fast", band: "cheap", label: "Fast — lightweight, cheapest", model: "auto/best-fast", ref: 0.6 },
  { id: "cheap", band: "cheap", label: "Cheap — economical", model: "auto/cheap", ref: 0.6 },
  { id: "free", band: "cheap", label: "Free — free-tier routed", model: "auto/best-free", ref: 0.6 },
];

/**
 * Derives the AXIS price for a request from the benchmarked provider's real cost:
 *   price_axis = max(minAxis, round( refUsdPer1M/1e6 * budgetTokens * discount / axisUsd ))
 * i.e. the buyer pays `discount` (default 0.5 = 50%) of what the same token
 * budget would cost at the reference provider, denominated in AXIS.
 */
function computePriceAxis(refUsdPer1M) {
  const tp = config.tokenPricing;
  const ref = Number(refUsdPer1M);
  if (!ref || ref <= 0) return String(tp.minAxis);
  const usd = (ref / 1e6) * tp.budgetTokens * tp.discount;
  const axis = usd / (tp.axisUsd > 0 ? tp.axisUsd : 0.0062);
  return String(Math.max(tp.minAxis, Math.round(axis)));
}

/** Parses OMNIROUTE_CATALOG (JSON) if set and valid, else the built-in bands. */
function omnirouteBands() {
  const raw = (process.env.OMNIROUTE_CATALOG || "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch (_) {
      // eslint-disable-next-line no-console
      console.warn("[models] OMNIROUTE_CATALOG is not valid JSON — using built-in bands");
    }
  }
  return OMNIROUTE_BANDS;
}

/** Which AI provider is configured. OmniRoute (if set) fronts everything else. */
function provider() {
  if (config.omniroute.url) return "omniroute";
  if (config.ai.anthropicKey) return "anthropic";
  if (config.ai.openaiKey) return "openai";
  return null;
}

/** Optional per-id price override, e.g. PRICE_PRO_AXIS / PRICE_FLASH_AXIS. */
function priceFor(id, fallback) {
  const env = process.env[`PRICE_${String(id).toUpperCase()}_AXIS`];
  return env != null && env !== "" ? env : fallback;
}

/**
 * Tiered model catalog with AXIS pricing. The more powerful the model, the more
 * AXIS it costs — so stronger compute drives more AXIS demand, and lighter
 * compute stays cheap. With OmniRoute configured this is the curated band list;
 * otherwise it's the classic three tiers for the direct OpenAI/Anthropic path.
 */
function catalog() {
  const p = provider();
  if (p === "omniroute") {
    const budget = config.tokenPricing.budgetTokens;
    return omnirouteBands().map((b) => ({
      id: b.id,
      label: b.label,
      band: b.band,
      provider: "omniroute",
      model: b.model,
      output_tokens: budget,
      price_axis: priceFor(b.id, b.price_axis != null ? b.price_axis : computePriceAxis(b.ref)),
    }));
  }

  const def = DEFAULTS[p] || DEFAULTS.anthropic;
  const tier = (id, label) => ({
    id,
    label,
    provider: p,
    model: config.ai.models[id] || def[id],
    price_axis: config.pricing[id],
  });
  return [
    tier("fast", "Fast — lightweight, cheapest"),
    tier("balanced", "Balanced — strong, mid price"),
    tier("pro", "Pro — most powerful, premium"),
  ];
}

function getTier(id) {
  return catalog().find((t) => t.id === id) || null;
}

module.exports = { catalog, getTier, provider };
