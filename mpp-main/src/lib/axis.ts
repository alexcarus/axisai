/// <reference types="vite/client" />
// ---------------------------------------------------------------------------
// AXIS AI — browser client for the Proof-of-AI-Work (PoAIW) protocol.
//
// This mirrors the canonical signing + submission scheme implemented by the
// monorepo's `packages/shared/src/wallet.js` and accepted by the API gateway
// (`packages/gateway`) and verification engine (`packages/engine`). It lets a
// browser derive a mining wallet, sign a work submission, and either:
//
//   1. submit to a live AXIS gateway (when VITE_AXIS_GATEWAY_URL is configured), or
//   2. fall back to a faithful local *simulation* of the PoAIW flow so the
//      landing page can demonstrate mining with no backend running.
//
// Canonical messages (must match the gateway byte-for-byte):
//   submission : AXIS-POAIW-SUBMISSION|<wallet_lower>|<work_type>|<input_hash>|<output_hash>|<timestamp>
//   read-auth  : AXIS-GATEWAY-AUTH|<wallet_lower>|<timestamp>
//   nonce      : keccak256("<wallet_lower>|<timestamp>|<block_height>")
// ---------------------------------------------------------------------------

import { type Hex, keccak256, stringToBytes, toHex } from "viem";
import {
  english,
  generateMnemonic,
  generatePrivateKey,
  mnemonicToAccount,
  type PrivateKeyAccount,
  privateKeyToAccount,
} from "viem/accounts";

// ---------------------------------------------------------------------------
// Work types — the seven PoAIW categories (whitepaper §5.1). Mirrors
// packages/shared/src/tasks.js, including sample() generators that produce
// output the engine's scoring functions accept.
// ---------------------------------------------------------------------------

export type WorkType = {
  id: string;
  label: string;
  icon: string;
  typicalW: number;
  instructions: string;
  sample: () => string;
};

function gaussian(): number {
  const u1 = Math.max(Math.random(), 1e-9);
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

export const WORK_TYPES: WorkType[] = [
  {
    id: "inference_text",
    label: "Text Inference",
    icon: "📝",
    typicalW: 1,
    instructions:
      "Run a text-generation task and submit the generated text. Aim for a coherent, relevant, well-structured response.",
    sample: () =>
      JSON.stringify({
        text: "the inference output is coherent relevant accurate and well structured natural language response",
      }),
  },
  {
    id: "inference_image",
    label: "Image Inference",
    icon: "🖼️",
    typicalW: 1,
    instructions:
      "Run an image inference task. Submit grayscale pixel arrays for your output and the reference for SSIM comparison.",
    sample: () => {
      const ref = Array.from({ length: 64 }, (_, i) => (i * 4) % 256);
      const out = ref.map((v) =>
        Math.min(255, Math.max(0, v + (Math.random() < 0.2 ? 3 : 0))),
      );
      return JSON.stringify({ pixels: out, reference: ref });
    },
  },
  {
    id: "inference_audio",
    label: "Audio Inference",
    icon: "🔊",
    typicalW: 1,
    instructions:
      "Run an audio inference task. Submit MFCC feature frames for your output and the reference for spectral comparison.",
    sample: () => {
      const ref = Array.from({ length: 40 }, (_, i) => Math.sin(i / 3));
      const out = ref.map((v) => v + (Math.random() - 0.5) * 0.05);
      return JSON.stringify({ mfcc: out, reference_mfcc: ref });
    },
  },
  {
    id: "training_step",
    label: "Training Step",
    icon: "🏋️",
    typicalW: 1,
    instructions:
      "Perform one training/fine-tuning step. Submit the architecture and loss before/after; loss must decrease plausibly.",
    sample: () =>
      JSON.stringify({
        architecture: "transformer",
        loss_before: 2.0,
        loss_after: 1.85,
        steps: 1,
      }),
  },
  {
    id: "dataset_labeling",
    label: "Dataset Labeling",
    icon: "🏷️",
    typicalW: 1,
    instructions:
      "Label a batch of items. Submit a batch_id and a labels map; agreement with peer labels drives your score.",
    sample: () =>
      JSON.stringify({
        batch_id: "batch-genesis-001",
        labels: { item1: "cat", item2: "dog", item3: "cat", item4: "bird" },
      }),
  },
  {
    id: "synthetic_data_generation",
    label: "Synthetic Data",
    icon: "🧪",
    typicalW: 1,
    instructions:
      "Generate synthetic samples matching a standard-normal reference. Submit a samples array; lower KL divergence scores higher.",
    sample: () =>
      JSON.stringify({
        samples: Array.from({ length: 200 }, () => gaussian()),
      }),
  },
  {
    id: "peer_validation",
    label: "Peer Validation",
    icon: "✅",
    typicalW: 1,
    instructions:
      "Validate another miner's output. Submit a target submission id and a 1–5 rating; consensus consistency scores higher.",
    sample: () =>
      JSON.stringify({ target_submission: "job-sample-target", rating: 4 }),
  },
];

const WORK_BY_ID: Record<string, WorkType> = Object.fromEntries(
  WORK_TYPES.map((w) => [w.id, w]),
);

export function getWorkType(id: string): WorkType | null {
  return WORK_BY_ID[id] ?? null;
}

// ---------------------------------------------------------------------------
// Token economics — Genesis emission schedule (whitepaper §4 / README).
// ---------------------------------------------------------------------------

export const AXIS_MAX_SUPPLY = 84_000_000;
export const AXIS_GENESIS_SUPPLY = 21_000_000;

export type Epoch = {
  name: string;
  baseReward: number;
  cumulativeEnd: number;
};

export const EPOCHS: Epoch[] = [
  { name: "Genesis 1", baseReward: 200, cumulativeEnd: 5_250_000 },
  { name: "Genesis 2", baseReward: 100, cumulativeEnd: 10_500_000 },
  { name: "Genesis 3", baseReward: 50, cumulativeEnd: 15_750_000 },
  { name: "Genesis 4", baseReward: 25, cumulativeEnd: 21_000_000 },
  { name: "Standard", baseReward: 12.5, cumulativeEnd: 63_000_000 },
  { name: "Late", baseReward: 6.25, cumulativeEnd: 79_800_000 },
  { name: "Terminal", baseReward: 3.125, cumulativeEnd: 84_000_000 },
];

export function epochForMinted(totalMinted: number): Epoch {
  return (
    EPOCHS.find((e) => totalMinted < e.cumulativeEnd) ??
    EPOCHS[EPOCHS.length - 1]
  );
}

// ---------------------------------------------------------------------------
// Wallet + signing — viem mirror of packages/shared/src/wallet.js
// ---------------------------------------------------------------------------

export type MiningWallet = {
  privateKey: Hex;
  address: string;
  account: PrivateKeyAccount;
  /** Present when the wallet was derived from a BIP-39 seed phrase. */
  mnemonic?: string;
};

/**
 * Monotonic millisecond clock. The gateway derives each submission's nonce from
 * (wallet, timestamp, block_height) and rejects duplicates, so when the miner
 * fires rapid or parallel rounds we must never reuse a timestamp. This always
 * returns a strictly increasing value, even within the same millisecond.
 */
let lastTimestamp = 0;
export function nextTimestamp(): number {
  const now = Date.now();
  lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
  return lastTimestamp;
}

export function generateMiningWallet(): MiningWallet {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address, account };
}

export function walletFromPrivateKey(privateKey: Hex): MiningWallet {
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address, account };
}

// ---------------------------------------------------------------------------
// Seed phrases (BIP-39) — a user-controlled, portable secret. The same 12
// words reproduce the same mining wallet on the web, in the terminal miner
// (bin/axis-miner.mjs --seed) and anywhere else, using the standard Ethereum
// derivation path m/44'/60'/0'/0/0. The seed never leaves the user's device —
// signing happens locally and AXIS never sees it.
// ---------------------------------------------------------------------------

/** A fresh BIP-39 12-word seed phrase (English wordlist). */
export function generateSeedPhrase(): string {
  return generateMnemonic(english);
}

/** Trims, lowercases and collapses whitespace in a seed phrase. */
export function normalizeMnemonic(input: string): string {
  return input.trim().toLowerCase().split(/\s+/).join(" ");
}

/** True if the string is a valid BIP-39 seed phrase. */
export function isValidMnemonic(input: string): boolean {
  try {
    mnemonicToAccount(normalizeMnemonic(input));
    return true;
  } catch {
    return false;
  }
}

/** Derives a mining wallet from a BIP-39 seed phrase. Throws if invalid. */
export function walletFromMnemonic(mnemonic: string): MiningWallet {
  const phrase = normalizeMnemonic(mnemonic);
  const hd = mnemonicToAccount(phrase);
  const privateKey = toHex(hd.getHdKey().privateKey as Uint8Array);
  const account = privateKeyToAccount(privateKey);
  return { privateKey, address: account.address, account, mnemonic: phrase };
}

/** A fresh mining wallet backed by a brand-new, backup-able 12-word seed. */
export function generateSeedWallet(): MiningWallet {
  return walletFromMnemonic(generateSeedPhrase());
}

/**
 * Imports a wallet from either a 0x-prefixed 64-hex private key or a BIP-39
 * seed phrase — e.g. a key exported from the Telegram bot, or a seed backed up
 * from another AXIS surface. Returns null when the input is neither.
 */
export function walletFromSecret(input: string): MiningWallet | null {
  const s = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return walletFromPrivateKey(s as Hex);
  if (isValidMnemonic(s)) return walletFromMnemonic(s);
  return null;
}

/** keccak256 over UTF-8 bytes — identical to the engine's `commit()`. */
export function commit(data: string): Hex {
  return keccak256(stringToBytes(data));
}

function submissionMessage(s: {
  wallet_address: string;
  work_type: string;
  input_hash: string;
  output_hash: string;
  timestamp: number;
}): string {
  return [
    "AXIS-POAIW-SUBMISSION",
    s.wallet_address.toLowerCase(),
    s.work_type,
    s.input_hash,
    s.output_hash,
    String(s.timestamp),
  ].join("|");
}

function authMessage(address: string, timestamp: number): string {
  return ["AXIS-GATEWAY-AUTH", address.toLowerCase(), String(timestamp)].join(
    "|",
  );
}

function computeNonce(
  address: string,
  timestamp: number,
  blockHeight: number,
): Hex {
  return keccak256(
    stringToBytes(`${address.toLowerCase()}|${timestamp}|${blockHeight}`),
  );
}

export type SubmissionBody = {
  wallet_address: string;
  work_type: string;
  input_hash: Hex;
  output_hash: Hex;
  output_data: string;
  timestamp: number;
  block_height: number;
  nonce: Hex;
  signature: Hex;
  channel: string;
};

/** Builds a fully-signed gateway submission body. */
export async function buildSubmission(
  wallet: MiningWallet,
  workType: string,
  outputData: string,
  opts: { blockHeight?: number; channel?: string; inputSeed?: string } = {},
): Promise<SubmissionBody> {
  const timestamp = nextTimestamp();
  const blockHeight = opts.blockHeight ?? 0;
  const inputHash = commit(opts.inputSeed ?? `input:${workType}:${timestamp}`);
  const outputHash = commit(outputData);

  const base = {
    wallet_address: wallet.address,
    work_type: workType,
    input_hash: inputHash,
    output_hash: outputHash,
    timestamp,
  };
  const signature = await wallet.account.signMessage({
    message: submissionMessage(base),
  });

  return {
    ...base,
    output_data: outputData,
    block_height: blockHeight,
    nonce: computeNonce(wallet.address, timestamp, blockHeight),
    signature,
    channel: opts.channel ?? "web",
  };
}

/** Signed headers for authenticated read endpoints. */
export async function buildAuthHeaders(
  wallet: MiningWallet,
): Promise<Record<string, string>> {
  const timestamp = nextTimestamp();
  const signature = await wallet.account.signMessage({
    message: authMessage(wallet.address, timestamp),
  });
  return {
    "x-wallet-address": wallet.address,
    "x-timestamp": String(timestamp),
    "x-signature": signature,
  };
}

// ---------------------------------------------------------------------------
// Gateway client (live mode)
// ---------------------------------------------------------------------------

export type SubmitResult = {
  status: number;
  body: {
    job_id?: string;
    status?: string;
    estimated_processing_seconds?: number;
    estimated_max_reward_axis?: string | null;
    error?: string;
    retry_after_seconds?: number;
  };
};

export type StatusResult = {
  status: number;
  body: {
    status?: "pending" | "approved" | "rejected" | "error";
    reward?: string;
    quality?: number;
    [k: string]: unknown;
  };
};

export type NetworkStats = {
  difficulty: number | null;
  base_difficulty?: number | null;
  /** Automatic post-Genesis (>25%) difficulty multiplier (1.0 = no ramp yet). */
  supply_difficulty_multiplier?: number | null;
  epoch: string | null;
  base_reward_axis: string | null;
  total_mined_axis: string | null;
  max_supply_axis: string;
  percent_of_supply_mined: number | null;
  genesis_supply_axis: string;
  active_miners_24h: number;
};

export class AxisGatewayClient {
  baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async submit(body: SubmissionBody): Promise<SubmitResult> {
    const res = await fetch(`${this.baseUrl}/gateway/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-channel": body.channel,
      },
      body: JSON.stringify(body),
    });
    const respBody = await res.json().catch(() => ({}));
    return { status: res.status, body: respBody };
  }

  async status(wallet: MiningWallet, jobId: string): Promise<StatusResult> {
    const headers = await buildAuthHeaders(wallet);
    const res = await fetch(
      `${this.baseUrl}/gateway/status/${encodeURIComponent(jobId)}`,
      { headers },
    );
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  async miner(
    wallet: MiningWallet,
  ): Promise<{ status: number; body: unknown }> {
    const headers = await buildAuthHeaders(wallet);
    const res = await fetch(
      `${this.baseUrl}/gateway/miner/${encodeURIComponent(wallet.address)}`,
      { headers },
    );
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  async networkStats(
    wallet: MiningWallet,
  ): Promise<{ status: number; body: NetworkStats }> {
    const headers = await buildAuthHeaders(wallet);
    const res = await fetch(`${this.baseUrl}/gateway/network/stats`, {
      headers,
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }
}

/**
 * Reads the configured gateway URL, or null for simulation mode. Uses static
 * `import.meta.env.VITE_AXIS_GATEWAY_URL` access (replaced at build time) — Vite's
 * SSR module runner rejects dynamic `import.meta.env` access, and this component
 * is server-rendered when embedded in MDX pages.
 */
export function gatewayUrl(): string | null {
  const url = import.meta.env.VITE_AXIS_GATEWAY_URL as string | undefined;
  return url && url.trim() ? url.trim() : null;
}

/**
 * The AXIS Telegram bot link, from VITE_TELEGRAM_BOT (a @username, bare
 * username, or full URL), or null when unset. Lets the web miner point users at
 * the bot to export their Telegram mining wallet and mine to it here too.
 */
export function telegramBotUrl(): string | null {
  const v = import.meta.env.VITE_TELEGRAM_BOT as string | undefined;
  if (!v || !v.trim()) return null;
  const s = v.trim();
  return s.startsWith("http") ? s : `https://t.me/${s.replace(/^@/, "")}`;
}

// ---------------------------------------------------------------------------
// Simulation mode — a faithful local model of PoAIW scoring + emission, used
// when no live gateway is configured. Reward = baseReward × W × Q / D.
// ---------------------------------------------------------------------------

/** Base difficulty `D` at genesis, before the supply ramp (mirrors the chain). */
export const SIM_DIFFICULTY = 100;

// ---------------------------------------------------------------------------
// Post-Genesis difficulty ramp (mirrors AXISToken.sol byte-for-byte in intent).
//
// Mining is easiest while the network bootstraps — the first 25% of supply
// (the Genesis Phase, 21,000,000 AXIS). Once 25% is mined an automatic,
// supply-driven multiplier kicks in and grows linearly from 1.0x at 25% to
// 8.0x at the 84,000,000 cap, so every AXIS past Genesis is harder to earn on
// top of the per-epoch base-reward halvings.
// ---------------------------------------------------------------------------

/** Difficulty multiplier once the whole supply is mined (1.0x → 8.0x). */
export const MAX_SUPPLY_DIFFICULTY_MULTIPLIER = 8;

/**
 * The automatic supply-driven difficulty multiplier for a given total minted.
 * Exactly 1.0 throughout Genesis (≤25%); ramps linearly to 8.0x at the cap.
 */
export function supplyDifficultyMultiplier(totalMinted: number): number {
  if (totalMinted <= AXIS_GENESIS_SUPPLY) return 1;
  const past = totalMinted - AXIS_GENESIS_SUPPLY;
  const span = AXIS_MAX_SUPPLY - AXIS_GENESIS_SUPPLY;
  const extra = (MAX_SUPPLY_DIFFICULTY_MULTIPLIER - 1) * (past / span);
  return Math.min(MAX_SUPPLY_DIFFICULTY_MULTIPLIER, 1 + extra);
}

/** Effective difficulty `Dₑ` = base difficulty × the supply ramp multiplier. */
export function simulatedDifficulty(totalMinted: number): number {
  return Math.round(SIM_DIFFICULTY * supplyDifficultyMultiplier(totalMinted));
}

// ---------------------------------------------------------------------------
// Aggressive mining cadence. The miner runs several concurrent workers and a
// tight loop so the network stays visibly busy. Live submissions are throttled
// by the gateway's per-wallet cooldown (WALLET_SUBMIT_COOLDOWN) — lower that on
// the gateway for a high-throughput public launch.
// ---------------------------------------------------------------------------
export const MINING = {
  /** Parallel mining workers. */
  concurrency: 4,
  /** Min/max delay between rounds within a worker (ms). */
  minDelayMs: 120,
  maxDelayMs: 360,
  /** Simulated verification latency (ms). */
  simMinLatencyMs: 280,
  simMaxLatencyMs: 720,
} as const;

/** Approximates the engine's quality scoring for the sample outputs. */
export function simulateQuality(workType: string): number {
  // The sample() generators are tuned to pass scoring; quality lands high with
  // some natural variance. Text inference scores slightly lower (length factor).
  const floor = workType === "inference_text" ? 0.8 : 0.82;
  const span = 0.97 - floor;
  const q = floor + Math.random() * span;
  // Rare lower-quality batch, like a noisy real submission.
  return Math.random() < 0.08 ? Math.max(0.55, q - 0.25) : q;
}

export function simulateReward(
  baseReward: number,
  workType: string,
  quality: number,
  difficulty: number = SIM_DIFFICULTY,
): number {
  const w = WORK_BY_ID[workType]?.typicalW ?? 1;
  return (baseReward * w * quality) / difficulty;
}

/** Plausible seed network state for simulation (mid Genesis-1). */
export function simulatedNetworkStats(totalMinted: number): NetworkStats {
  const epoch = epochForMinted(totalMinted);
  return {
    difficulty: simulatedDifficulty(totalMinted),
    base_difficulty: SIM_DIFFICULTY,
    supply_difficulty_multiplier: supplyDifficultyMultiplier(totalMinted),
    epoch: epoch.name,
    base_reward_axis: String(epoch.baseReward),
    total_mined_axis: totalMinted.toFixed(2),
    max_supply_axis: String(AXIS_MAX_SUPPLY),
    percent_of_supply_mined: (totalMinted / AXIS_MAX_SUPPLY) * 100,
    genesis_supply_axis: String(AXIS_GENESIS_SUPPLY),
    active_miners_24h: 2100 + Math.floor(Math.random() * 400),
  };
}

export const SIM_SEED_MINTED = 3_142_000;

export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
