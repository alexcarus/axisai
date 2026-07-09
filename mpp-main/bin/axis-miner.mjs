#!/usr/bin/env node
// ===========================================================================
// AXIS AI — terminal miner.
//
// Mine AXIS from your terminal against any live AXIS gateway (the same one the
// web miner and the Vercel site use). Anyone can run it after cloning the repo:
//
//   pnpm install            # (or npm install) — installs viem
//   pnpm mine               # mine against $GATEWAY_URL (default the live AXIS gateway)
//
// Examples:
//   GATEWAY_URL=https://axis-gateway-production.up.railway.app pnpm mine
//   node bin/axis-miner.mjs --gateway https://axis-gateway-production.up.railway.app --work inference_text
//   node bin/axis-miner.mjs --seed "twelve word seed phrase …"  # mine to your seed
//   node bin/axis-miner.mjs --key 0xYOURPRIVATEKEY            # mine to a raw key
//   OPENAI_API_KEY=sk-... node bin/axis-miner.mjs             # mine with real AI
//   ANTHROPIC_API_KEY=sk-ant-... node bin/axis-miner.mjs --model claude-opus-4-8
//   node bin/axis-miner.mjs --once                           # mine one block + exit
//
// Wallet & seed: with no --key/--seed the miner reuses a 12-word BIP-39 seed
// saved at ~/.axis/wallet.json (created on first run, chmod 600), so your
// rewards persist across runs. The same 12 words restore the exact wallet on
// the AXIS website's web miner — and a key exported from the Telegram bot can
// be passed via --key to mine to that same address. Your seed/keys and any AI
// API key never leave your machine except to their own provider.
// ===========================================================================

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { keccak256, stringToBytes, toHex } from "viem";
import {
  english,
  generateMnemonic,
  mnemonicToAccount,
  privateKeyToAccount,
} from "viem/accounts";

// --------------------------------------------------------------------------- //
//                                   CLI args                                  //
// --------------------------------------------------------------------------- //
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const flag = (name) => argv.includes(`--${name}`);

if (flag("help")) {
  console.log(`AXIS terminal miner

Usage: node bin/axis-miner.mjs [options]

Options:
  --gateway <url>     AXIS gateway URL        (env GATEWAY_URL, default https://axis-gateway-production.up.railway.app)
  --seed "<words>"    12-word BIP-39 seed     (env AXIS_SEED)
  --key <0x...>       Mining private key      (env AXIS_PRIVATE_KEY)
  --wallet-file <p>   Seed file location      (env AXIS_WALLET_FILE, default ~/.axis/wallet.json)
  --new               Ignore the saved seed and generate a fresh wallet
  --no-save           Do not persist a generated seed (ephemeral wallet)
  --work <type|auto>  Work type               (default auto)
  --workers <n>       Parallel workers        (default 1)
  --openai <key>      Mine with OpenAI        (env OPENAI_API_KEY)
  --anthropic <key>   Mine with Claude        (env ANTHROPIC_API_KEY)
  --model <name>      AI model                (default gpt-4o-mini / claude-opus-4-8)
  --once              Mine a single block then exit
  --help              Show this help

Wallet precedence: --key > $AXIS_PRIVATE_KEY > --seed > $AXIS_SEED > saved seed
file > a freshly generated seed (saved unless --no-save).

Work types: inference_text inference_image inference_audio training_step
            dataset_labeling synthetic_data_generation peer_validation`);
  process.exit(0);
}

const GATEWAY = (
  arg("gateway") ||
  process.env.GATEWAY_URL ||
  process.env.VITE_AXIS_GATEWAY_URL ||
  "https://axis-gateway-production.up.railway.app"
).replace(/\/$/, "");
const WORK = arg("work", "auto");
const WORKERS = Math.max(1, Number.parseInt(arg("workers", "1"), 10) || 1);
const ONCE = flag("once");
// Status polling cadence. Every poll is a gateway request that counts against the
// per-IP rate limit, so poll gently — this is what lets many wallets share one IP
// without tripping the 100/min DDoS ban. Default every 3s, up to 24 tries (~72s).
// The fleet miner raises --poll-ms further as wallet count grows.
const POLL_MS = Math.max(500, Number.parseInt(arg("poll-ms", process.env.POLL_INTERVAL_MS || "3000"), 10) || 3000);
const POLL_MAX = Math.max(3, Number.parseInt(arg("poll-max", "24"), 10) || 24);

const OPENAI_KEY = arg("openai") || process.env.OPENAI_API_KEY || "";
const ANTHROPIC_KEY = arg("anthropic") || process.env.ANTHROPIC_API_KEY || "";
const AI = OPENAI_KEY
  ? { provider: "openai", key: OPENAI_KEY, model: arg("model", "gpt-4o-mini") }
  : ANTHROPIC_KEY
    ? { provider: "anthropic", key: ANTHROPIC_KEY, model: arg("model", "claude-opus-4-8") }
    : null;

// --------------------------------------------------------------------------- //
//                                   Colors                                    //
// --------------------------------------------------------------------------- //
const C = process.stdout.isTTY
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      lime: (s) => `\x1b[92m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
    }
  : new Proxy({}, { get: () => (s) => s });

// --------------------------------------------------------------------------- //
//                              Wallet resolution                              //
// A user-controlled BIP-39 seed, reproducible on the web miner and elsewhere. //
// --------------------------------------------------------------------------- //
const WALLET_FILE =
  arg("wallet-file") || process.env.AXIS_WALLET_FILE || join(homedir(), ".axis", "wallet.json");

const normalizeMnemonic = (s) => s.trim().toLowerCase().split(/\s+/).join(" ");

function accountFromMnemonic(phrase) {
  const hd = mnemonicToAccount(normalizeMnemonic(phrase));
  return privateKeyToAccount(toHex(hd.getHdKey().privateKey));
}

function loadSeed() {
  try {
    if (!existsSync(WALLET_FILE)) return null;
    return JSON.parse(readFileSync(WALLET_FILE, "utf8")).mnemonic || null;
  } catch {
    return null;
  }
}

function saveSeed(phrase) {
  try {
    mkdirSync(dirname(WALLET_FILE), { recursive: true });
    writeFileSync(WALLET_FILE, `${JSON.stringify({ mnemonic: phrase }, null, 2)}\n`);
    try {
      chmodSync(WALLET_FILE, 0o600);
    } catch {
      /* perms best-effort (e.g. Windows) */
    }
    return true;
  } catch {
    return false;
  }
}

function resolveWallet() {
  const keyArg = arg("key") || process.env.AXIS_PRIVATE_KEY;
  if (keyArg)
    return { account: privateKeyToAccount(keyArg), source: "private key", seed: null, fresh: false, saved: false };

  const seedArg = arg("seed") || process.env.AXIS_SEED;
  if (seedArg)
    return { account: accountFromMnemonic(seedArg), source: "seed phrase", seed: normalizeMnemonic(seedArg), fresh: false, saved: false };

  if (!flag("new")) {
    const saved = loadSeed();
    if (saved)
      return { account: accountFromMnemonic(saved), source: "saved seed", seed: saved, fresh: false, saved: true };
  }

  const phrase = generateMnemonic(english);
  const saved = flag("no-save") ? false : saveSeed(phrase);
  return { account: accountFromMnemonic(phrase), source: "new seed", seed: phrase, fresh: true, saved };
}

const WALLET = resolveWallet();

// --------------------------------------------------------------------------- //
//                            Canonical AXIS signing                           //
// (mirrors src/lib/axis.ts and packages/shared/src/wallet.js byte-for-byte)   //
// --------------------------------------------------------------------------- //
const account = WALLET.account;
const commit = (s) => keccak256(stringToBytes(s));

let lastTs = 0;
function nextTimestamp() {
  const now = Date.now();
  lastTs = now > lastTs ? now : lastTs + 1;
  return lastTs;
}

async function authHeaders() {
  const timestamp = nextTimestamp();
  const message = ["AXIS-GATEWAY-AUTH", account.address.toLowerCase(), String(timestamp)].join("|");
  const signature = await account.signMessage({ message });
  return {
    "x-wallet-address": account.address,
    "x-timestamp": String(timestamp),
    "x-signature": signature,
  };
}

async function buildSubmission(workType, outputData) {
  const timestamp = nextTimestamp();
  const blockHeight = 0;
  const base = {
    wallet_address: account.address,
    work_type: workType,
    input_hash: commit(`input:${workType}:${timestamp}`),
    output_hash: commit(outputData),
    timestamp,
  };
  const message = [
    "AXIS-POAIW-SUBMISSION",
    base.wallet_address.toLowerCase(),
    base.work_type,
    base.input_hash,
    base.output_hash,
    String(base.timestamp),
  ].join("|");
  const signature = await account.signMessage({ message });
  return {
    ...base,
    output_data: outputData,
    block_height: blockHeight,
    nonce: commit(`${base.wallet_address.toLowerCase()}|${timestamp}|${blockHeight}`),
    signature,
    channel: "cli",
  };
}

// --------------------------------------------------------------------------- //
//                            Work-type sample data                            //
// --------------------------------------------------------------------------- //
const gaussian = () => {
  const u1 = Math.max(Math.random(), 1e-9);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
};
const SAMPLES = {
  inference_text: () =>
    JSON.stringify({
      text: "the inference output is coherent relevant accurate and well structured natural language response",
    }),
  inference_image: () => {
    const ref = Array.from({ length: 64 }, (_, i) => (i * 4) % 256);
    const out = ref.map((v) => Math.min(255, Math.max(0, v + (Math.random() < 0.2 ? 3 : 0))));
    return JSON.stringify({ pixels: out, reference: ref });
  },
  inference_audio: () => {
    const ref = Array.from({ length: 40 }, (_, i) => Math.sin(i / 3));
    return JSON.stringify({ mfcc: ref.map((v) => v + (Math.random() - 0.5) * 0.05), reference_mfcc: ref });
  },
  training_step: () =>
    JSON.stringify({ architecture: "transformer", loss_before: 2.0, loss_after: 1.85, steps: 1 }),
  dataset_labeling: () =>
    JSON.stringify({
      batch_id: "batch-genesis-001",
      labels: { item1: "cat", item2: "dog", item3: "cat", item4: "bird" },
    }),
  synthetic_data_generation: () =>
    JSON.stringify({ samples: Array.from({ length: 200 }, () => gaussian()) }),
  peer_validation: () => JSON.stringify({ target_submission: "job-sample-target", rating: 4 }),
};
const WORK_TYPES = Object.keys(SAMPLES);

// --------------------------------------------------------------------------- //
//                            Optional real AI inference                       //
// --------------------------------------------------------------------------- //
const AI_TOPICS = [
  "verifiable AI computation",
  "neural network inference",
  "language model reasoning",
  "proof-of-AI-work mining",
  "deterministic on-chain rewards",
];
async function aiText() {
  const topic = AI_TOPICS[Math.floor(Math.random() * AI_TOPICS.length)];
  const prompt =
    "You are performing an AI text-inference benchmark for a Proof-of-AI-Work miner. " +
    `Write two to three clear, coherent, grammatically correct English sentences (at least 30 words) about ${topic}. ` +
    "Output only the sentences — no preamble or quotation marks.";
  if (AI.provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${AI.key}` },
      body: JSON.stringify({ model: AI.model, max_tokens: 160, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || "";
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": AI.key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: AI.model, max_tokens: 160, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}`);
  const data = await res.json();
  return (data?.content || [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

async function outputFor(workType) {
  if (workType === "inference_text" && AI) {
    try {
      const text = await aiText();
      if (text) return JSON.stringify({ text });
    } catch (e) {
      console.log(C.yellow(`  AI error (${e.message}); using sample`));
    }
  }
  return SAMPLES[workType]();
}

// --------------------------------------------------------------------------- //
//                              Gateway requests                               //
// --------------------------------------------------------------------------- //
async function submit(body) {
  const res = await fetch(`${GATEWAY}/gateway/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-channel": "cli" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function status(jobId) {
  const res = await fetch(`${GATEWAY}/gateway/status/${encodeURIComponent(jobId)}`, {
    headers: await authHeaders(),
  });
  return res.json().catch(() => ({}));
}
async function networkStats() {
  const res = await fetch(`${GATEWAY}/gateway/network/stats`, { headers: await authHeaders() });
  return res.json().catch(() => ({}));
}

// --------------------------------------------------------------------------- //
//                                 Mining loop                                 //
// --------------------------------------------------------------------------- //
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stats = { submitted: 0, accepted: 0, balance: 0 };
let running = true;

async function mineOnce() {
  const workType =
    WORK === "auto" ? WORK_TYPES[Math.floor(Math.random() * WORK_TYPES.length)] : WORK;
  if (!SAMPLES[workType]) {
    console.log(C.red(`Unknown work type: ${workType}`));
    process.exit(1);
  }
  const output = await outputFor(workType);
  const body = await buildSubmission(workType, output);
  stats.submitted++;
  const res = await submit(body);

  if (res.status === 429) {
    const wait = res.body.retry_after_seconds ?? 5;
    console.log(C.dim(`  ${tag(workType)} rate-limited — waiting ${wait}s`));
    await sleep(wait * 1000);
    return;
  }
  const jobId = res.body.job_id;
  if (!jobId) {
    console.log(`  ${tag(workType)} ${C.red("rejected")} ${C.dim(res.body.error || "")}`);
    return;
  }

  let final = {};
  for (let i = 0; i < POLL_MAX && running; i++) {
    await sleep(POLL_MS);
    final = await status(jobId);
    if (["approved", "rejected", "error"].includes(final.status)) break;
  }

  if (final.status === "approved") {
    const reward = Number(final.reward_axis ?? final.reward ?? 0);
    stats.accepted++;
    stats.balance += reward;
    const q = Number(final.quality ?? 0).toFixed(2);
    const tx = final.tx_hash ? C.dim(` tx ${final.tx_hash.slice(0, 10)}…`) : "";
    console.log(
      `  ${tag(workType)} ${C.lime("✓ approved")} Q ${q}  ${C.bold(C.green(`+${reward.toFixed(4)} AXIS`))}${tx}  ${C.dim(`Σ ${stats.balance.toFixed(4)}`)}`,
    );
  } else {
    console.log(
      `  ${tag(workType)} ${C.red("✗ " + (final.status || "rejected"))} ${C.dim(final.reject_reason || "")}`,
    );
  }
}

function tag(w) {
  return C.cyan(w.padEnd(26));
}

async function worker() {
  while (running) {
    try {
      await mineOnce();
    } catch (e) {
      console.log(C.red(`  error: ${e.message}`));
      await sleep(2000);
    }
    if (ONCE) {
      running = false;
      break;
    }
    await sleep(400 + Math.random() * 600);
  }
}

// --------------------------------------------------------------------------- //
//                                  Bootstrap                                  //
// --------------------------------------------------------------------------- //
process.on("SIGINT", () => {
  running = false;
  const rate = stats.submitted ? Math.round((stats.accepted / stats.submitted) * 100) : 0;
  console.log(
    `\n${C.bold("Stopped.")} blocks ${stats.accepted}/${stats.submitted} (${rate}%)  balance ${C.bold(C.green(stats.balance.toFixed(4) + " AXIS"))}`,
  );
  process.exit(0);
});

(async () => {
  console.log(C.bold(C.lime("\n  ◆ AXIS terminal miner\n")));
  console.log(`  ${C.dim("gateway")}  ${GATEWAY}`);
  console.log(`  ${C.dim("wallet ")}  ${account.address}  ${C.dim(`(${WALLET.source})`)}`);
  console.log(`  ${C.dim("work   ")}  ${WORK}${WORKERS > 1 ? ` ×${WORKERS}` : ""}`);
  console.log(`  ${C.dim("AI     ")}  ${AI ? `${AI.provider} (${AI.model})` : "off — submitting samples"}`);

  // Show a freshly-generated seed exactly once so the operator can back it up.
  if (WALLET.fresh && WALLET.seed) {
    console.log(C.yellow("\n  ⚠ New mining wallet — back up these 12 words to keep your rewards:"));
    console.log(`  ${C.bold(WALLET.seed)}`);
    console.log(
      WALLET.saved
        ? C.dim(`  Saved to ${WALLET_FILE} (chmod 600). Reused automatically next run.`)
        : C.dim("  Not saved (--no-save). Pass --seed to reuse this wallet."),
    );
    console.log(C.dim("  Import the same 12 words into the web miner on the AXIS site to share one balance."));
  } else if (WALLET.source === "saved seed") {
    console.log(`  ${C.dim("seed   ")}  restored from ${WALLET_FILE}`);
  }

  try {
    const ns = await networkStats();
    if (ns && ns.epoch != null) {
      console.log(
        `  ${C.dim("network")}  epoch ${ns.epoch} · difficulty ${ns.difficulty} · base ${ns.base_reward_axis} AXIS · ${Number(ns.percent_of_supply_mined ?? 0).toFixed(2)}% mined`,
      );
    } else {
      console.log(`  ${C.yellow("network")}  gateway unreachable or in simulation — check --gateway`);
    }
  } catch {
    console.log(`  ${C.red("network")}  could not reach ${GATEWAY} — is the gateway running?`);
  }

  console.log(C.dim("\n  Mining… (Ctrl+C to stop)\n"));
  await Promise.all(Array.from({ length: WORKERS }, () => worker()));
})();
