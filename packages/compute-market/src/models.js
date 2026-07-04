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

/** Which AI provider is configured (anthropic preferred), or null. */
function provider() {
  if (config.ai.anthropicKey) return "anthropic";
  if (config.ai.openaiKey) return "openai";
  return null;
}

/**
 * Tiered model catalog with AXIS pricing. The more powerful the model, the more
 * AXIS it costs — so stronger compute drives more AXIS demand, and lighter
 * compute stays cheap.
 */
function catalog() {
  const p = provider();
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
