#!/usr/bin/env node
// ===========================================================================
// AXIS AI — compute miner (serve real inference, earn AXIS).
//
// Runs on a miner's machine. It claims paid jobs from the compute market, runs
// the requested model with the MINER's OWN AI key, submits the result, and the
// market's treasury pays the buyer's AXIS straight to this wallet.
//
//   MARKET_URL=https://compute-market-production.up.railway.app \
//   MINER_PRIVATE_KEY=0x...    (the wallet that receives AXIS) \
//   ANTHROPIC_API_KEY=sk-ant-... (or OPENAI_API_KEY) \
//   node bin/axis-serve.mjs
// ===========================================================================
import { Wallet } from "ethers";

const MARKET_URL = (process.env.MARKET_URL || "http://localhost:4100").replace(/\/$/, "");
const PRIV = process.env.MINER_PRIVATE_KEY || "";
const OPENAI = process.env.OPENAI_API_KEY || "";
const ANTHROPIC = process.env.ANTHROPIC_API_KEY || "";

if (!PRIV) {
  console.error("Set MINER_PRIVATE_KEY (the wallet that receives AXIS payouts).");
  process.exit(1);
}
if (!OPENAI && !ANTHROPIC) {
  console.error("Set ANTHROPIC_API_KEY or OPENAI_API_KEY (you run the model, you pay the API).");
  process.exit(1);
}

const PROVIDER = ANTHROPIC ? "anthropic" : "openai";
const MODELS = {
  anthropic: { fast: "claude-haiku-4-5", balanced: "claude-sonnet-4-6", pro: "claude-opus-4-8" },
  openai: { fast: "gpt-4o-mini", balanced: "gpt-4o", pro: "o3" },
};

const wallet = new Wallet(PRIV);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function authHeaders() {
  const ts = String(Date.now());
  const sig = await wallet.signMessage(`AXIS-COMPUTE-MINER|${wallet.address.toLowerCase()}|${ts}`);
  return {
    "Content-Type": "application/json",
    "x-wallet-address": wallet.address,
    "x-timestamp": ts,
    "x-signature": sig,
  };
}

async function infer(tierId, prompt) {
  const model = MODELS[PROVIDER][tierId] || MODELS[PROVIDER].fast;
  if (PROVIDER === "openai") {
    // o-series reasoning models (o1/o3/o4-…) need `max_completion_tokens`, not
    // `max_tokens`, and reasoning tokens count against it — budget generously.
    const reasoning = /^o[0-9]/i.test(model);
    const body = { model, messages: [{ role: "user", content: prompt }] };
    if (reasoning) body.max_completion_tokens = 16000;
    else body.max_tokens = Number(process.env.OUTPUT_TOKEN_BUDGET || 8000);
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text().catch(() => "")).slice(0, 180)}`);
    const d = await res.json();
    return (d.choices?.[0]?.message?.content || "").trim();
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: Number(process.env.OUTPUT_TOKEN_BUDGET || 8000), messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const d = await res.json();
  return (d.content?.[0]?.text || "").trim();
}

console.log(`◆ AXIS compute miner`);
console.log(`  market  ${MARKET_URL}`);
console.log(`  wallet  ${wallet.address}  (payouts land here)`);
console.log(`  model   ${PROVIDER}\n  waiting for jobs…\n`);

while (true) {
  try {
    const next = await fetch(`${MARKET_URL}/jobs/next`, { method: "POST", headers: await authHeaders() })
      .then((r) => r.json())
      .catch(() => ({ none: true }));

    if (next.error) {
      // Most commonly the Genesis gate (pre-25%) — wait and retry.
      console.log(`  ${next.error}`);
      await sleep(30000);
      continue;
    }
    if (next.none || !next.job_id) {
      await sleep(5000);
      continue;
    }

    console.log(`→ job ${next.job_id} (${next.model})`);
    let output;
    try {
      output = await infer(next.model, next.prompt);
    } catch (e) {
      console.error(`  inference failed: ${e.message}`);
      await sleep(2000);
      continue;
    }

    const result = await fetch(`${MARKET_URL}/jobs/result`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ job_id: next.job_id, output }),
    })
      .then((r) => r.json())
      .catch((e) => ({ error: e.message }));

    if (result.ok) console.log(`✓ paid ${result.paid_axis} AXIS  (tx ${result.payout_tx})`);
    else console.error(`  result rejected: ${result.error}`);
  } catch (e) {
    console.error(`  loop error: ${e.message}`);
    await sleep(5000);
  }
}
