"use strict";

const config = require("./config");

// Cheap grader model per provider — used only to validate a miner's result.
const VERIFIER = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  cloudflare: "@cf/meta/llama-3.1-8b-instruct-fp8",
};

function verifierProvider() {
  if (config.ai.anthropicKey) return { p: "anthropic", key: config.ai.anthropicKey };
  if (config.ai.openaiKey) return { p: "openai", key: config.ai.openaiKey };
  // The market runs on Cloudflare Workers AI — grade with a cheap CF model so
  // miner payouts work without a separate Anthropic/OpenAI key.
  if (config.cloudflare.accountId && config.cloudflare.apiToken)
    return { p: "cloudflare", key: config.cloudflare.apiToken, account: config.cloudflare.accountId };
  return null;
}

async function grade(prompt, output) {
  const v = verifierProvider();
  if (!v) return null;
  const content =
    "You are a strict grader for an AI compute marketplace. Decide whether the RESPONSE is a genuine, relevant, good-faith attempt to complete the TASK — not gibberish, not empty filler, not a refusal, not unrelated. Reply with exactly one word: YES or NO.\n\n" +
    `TASK:\n${String(prompt).slice(0, 4000)}\n\nRESPONSE:\n${String(output).slice(0, 4000)}`;

  if (v.p === "cloudflare") {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${v.account}/ai/v1/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${v.key}` },
        body: JSON.stringify({ model: VERIFIER.cloudflare, max_tokens: 4, messages: [{ role: "user", content }] }),
      },
    );
    if (!res.ok) throw new Error(`verifier ${res.status}`);
    const d = await res.json();
    return d.choices?.[0]?.message?.content || "";
  }
  if (v.p === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${v.key}` },
      body: JSON.stringify({ model: VERIFIER.openai, max_tokens: 4, messages: [{ role: "user", content }] }),
    });
    if (!res.ok) throw new Error(`verifier ${res.status}`);
    const d = await res.json();
    return d.choices?.[0]?.message?.content || "";
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": v.key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: VERIFIER.anthropic, max_tokens: 4, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`verifier ${res.status}`);
  const d = await res.json();
  return d.content?.[0]?.text || "";
}

/**
 * Validates a miner's result before it gets paid. Basic sanity checks always
 * apply; if a verifier AI key is configured, a cheap grader model also judges
 * whether the output genuinely addresses the prompt. Returns { ok, reason }.
 * Fails OPEN on a transient verifier error (the miner did real work), fails
 * CLOSED on an explicit rejection or a failed sanity check.
 */
async function verifyResult(prompt, output) {
  const o = (output || "").trim();
  if (o.length < 10) return { ok: false, reason: "output too short" };
  if (o.toLowerCase() === String(prompt || "").trim().toLowerCase())
    return { ok: false, reason: "output just echoes the prompt" };
  if (!verifierProvider()) {
    // Without a grader, basic checks alone would pay for any non-empty output.
    // In production that's a payout-for-garbage risk, so fail CLOSED (no payout)
    // and force the operator to configure a verifier key; dev stays lenient.
    if (process.env.NODE_ENV === "production") {
      return { ok: false, reason: "no verifier key configured — refusing to pay unverified work" };
    }
    return { ok: true, reason: "basic checks (no verifier key — dev only)" };
  }
  try {
    const verdict = await grade(prompt, output);
    const ok = /\byes\b/i.test(verdict || "");
    return { ok, reason: ok ? "verified" : "grader rejected the result" };
  } catch (_e) {
    // Transient grader error. In production, fail CLOSED — do NOT pay for work we
    // couldn't verify (the job is requeued for another miner, so a real outage
    // degrades throughput, not payout integrity). Dev stays lenient so the local
    // stack works without a grader key.
    if (process.env.NODE_ENV === "production") {
      return { ok: false, reason: "verifier unavailable — not paying unverified work" };
    }
    return { ok: true, reason: "verifier unavailable — passed on basic checks (dev only)" };
  }
}

module.exports = { verifyResult };
