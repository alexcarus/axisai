"use strict";

const config = require("./config");

/**
 * Alternate OmniRoute routes tried (in order) when the chosen model fails, so a
 * transient free-provider 503 on one route still fulfils via another. All are
 * OmniRoute routes — NO external provider. Tunable via OMNIROUTE_FALLBACK_ROUTES.
 */
const OMNIROUTE_FALLBACK_ROUTES = (
  process.env.OMNIROUTE_FALLBACK_ROUTES ||
  "cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast,cf/@cf/meta/llama-3.1-8b-instruct-fp8,cf/@cf/meta/llama-3.2-3b-instruct"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Single OmniRoute (OpenAI-compatible) call for one model id. Throws on failure/empty. */
async function callOmniRoute(model, prompt) {
  const headers = { "Content-Type": "application/json" };
  if (config.omniroute.apiKey) headers.Authorization = `Bearer ${config.omniroute.apiKey}`;
  // Bound each attempt so a slow/hung route can't stall the whole rotation.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Number.parseInt(process.env.OMNIROUTE_TIMEOUT_MS || "45000", 10),
  );
  try {
    const res = await fetch(`${config.omniroute.url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        // Buyer paid for up to this many output tokens (see config.tokenPricing).
        max_tokens: config.tokenPricing.budgetTokens,
        // OmniRoute streams (SSE) by default; we want one JSON body to parse.
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OmniRoute ${res.status}: ${detail.slice(0, 180)}`);
    }
    const data = await res.json();
    const out = (data.choices?.[0]?.message?.content || "").trim();
    if (!out) throw new Error("OmniRoute returned empty output");
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** Direct Anthropic Messages call — paid-key fallback when OmniRoute fails. */
async function callAnthropic(model, prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.ai.anthropicKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: config.tokenPricing.budgetTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  return (data.content?.[0]?.text || "").trim();
}

/** Direct OpenAI Chat Completions call — paid-key fallback (used if no Anthropic key). */
async function callOpenAI(model, prompt) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.ai.openaiKey}` },
    body: JSON.stringify({ model, max_tokens: config.tokenPricing.budgetTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

/** Maps an OmniRoute band to a concrete model on the direct fallback provider. */
function fallbackModel(band, prov) {
  if (prov === "anthropic") {
    return { flagship: "claude-opus-4-8", high: "claude-sonnet-4-6", mid: "claude-haiku-4-5", cheap: "claude-haiku-4-5" }[band] || "claude-haiku-4-5";
  }
  return band === "flagship" || band === "high" ? "gpt-4o" : "gpt-4o-mini";
}

/**
 * Runs a real model inference for a tier and returns the generated text. This is
 * genuine compute paid for in AXIS — the buyer gets the output, the operator's
 * API key does the work.
 */
async function runInference(tier, prompt) {
  // OmniRoute — an OpenAI-compatible gateway. One base URL fronts many providers
  // and models; we just pass the tier's model id through the standard Chat
  // Completions shape and read the OpenAI-style response.
  if (tier.provider === "omniroute") {
    if (!config.omniroute.url) throw new Error("OMNIROUTE_URL not configured");
    // Try the chosen model, then rotate through alternate OmniRoute routes so a
    // transient free-provider failure on one route still fulfils via another —
    // all within OmniRoute, no external provider.
    const routes = [tier.model, ...OMNIROUTE_FALLBACK_ROUTES.filter((r) => r !== tier.model)];
    let lastErr;
    for (const m of routes) {
      try {
        return await callOmniRoute(m, prompt);
      } catch (e) {
        lastErr = e;
      }
    }
    // Every free OmniRoute route failed — fulfil the paid order via the direct
    // provider key (reliability backstop). Anthropic preferred, else OpenAI.
    if (config.ai.anthropicKey) return callAnthropic(fallbackModel(tier.band, "anthropic"), prompt);
    if (config.ai.openaiKey) return callOpenAI(fallbackModel(tier.band, "openai"), prompt);
    throw lastErr || new Error("OmniRoute: all routes failed and no fallback key configured");
  }

  if (tier.provider === "openai") {
    // o-series reasoning models (o1/o3/o4-…) reject `max_tokens` — they use
    // `max_completion_tokens`, and hidden reasoning tokens count against it, so
    // give a large budget or the visible answer gets starved. Non-reasoning
    // chat models keep the normal `max_tokens`.
    const reasoning = /^o[0-9]/i.test(tier.model);
    const body = { model: tier.model, messages: [{ role: "user", content: prompt }] };
    if (reasoning) body.max_completion_tokens = 16000;
    else body.max_tokens = 1024;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.ai.openaiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenAI ${res.status}: ${detail.slice(0, 180)}`);
    }
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || "").trim();
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.ai.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: tier.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  return (data.content?.[0]?.text || "").trim();
}

// --- Free "Ask AI about AXIS" Q&A ----------------------------------------
const ASK_MODEL = { anthropic: "claude-haiku-4-5", openai: "gpt-4o-mini" };
const AXIS_CONTEXT =
  "You are the assistant for AXIS AI — a Proof-of-AI-Work, fixed-supply (84,000,000) mineable ERC-20 on Base. No premine, no owner. Facts: AXIS is minted by verifiable AI work; the Genesis Phase is the first 25% of supply (easy mining), after which difficulty ramps up and real AI inference is required. There is a Uniswap v4 AXIS/USDC market on Base, Telegram + WhatsApp mining bots, and a compute marketplace where people pay AXIS for real AI inference served by distributed miners (activates at 25%; miners earn the buyer's AXIS). Answer questions about AXIS AI clearly and concisely. You provide information only — never give financial or investment advice or price predictions; if asked, politely decline and clarify it's informational.";

function askProvider() {
  if (config.ai.anthropicKey) return { p: "anthropic", key: config.ai.anthropicKey };
  if (config.ai.openaiKey) return { p: "openai", key: config.ai.openaiKey };
  return null;
}

function askConfigured() {
  return !!askProvider();
}

/** Answers a question about AXIS AI using a cheap model + project context. */
async function askAxis(question) {
  const ai = askProvider();
  if (!ai) throw new Error("no AI key configured");
  const model = ASK_MODEL[ai.p];
  if (ai.p === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.key}` },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        messages: [
          { role: "system", content: AXIS_CONTEXT },
          { role: "user", content: question },
        ],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const d = await res.json();
    return (d.choices?.[0]?.message?.content || "").trim();
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ai.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system: AXIS_CONTEXT,
      messages: [{ role: "user", content: question }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const d = await res.json();
  return (d.content?.[0]?.text || "").trim();
}

module.exports = { runInference, askAxis, askConfigured };
