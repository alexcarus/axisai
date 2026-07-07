"use strict";

require("dotenv").config();
const { ethers } = require("ethers");

/**
 * AXIS AI Compute Market — configuration.
 *
 * A pure ADD-ON over the live AXIS ERC-20 (no contract changes). Buyers pay AXIS
 * into the treasury; distributed miners claim the job, run it with their OWN AI
 * key, submit the result, and the treasury pays them the buyer's AXIS. Pricing
 * is tiered — a more powerful model costs more AXIS.
 */

const treasuryKey = process.env.TREASURY_PRIVATE_KEY || "";

// payTo (where buyers send AXIS) is the treasury address when a treasury key is
// set, so payments and miner payouts use the same wallet. Otherwise fall back to
// an explicit COMPUTE_MARKET_PAYTO (collect-only, no distributed payouts).
let payTo = (process.env.COMPUTE_MARKET_PAYTO || "").trim();
if (treasuryKey) {
  try {
    payTo = new ethers.Wallet(treasuryKey).address;
  } catch (_) {
    /* invalid key — leave payTo as configured */
  }
}

module.exports = {
  port: Number.parseInt(process.env.PORT || process.env.COMPUTE_PORT || "4100", 10),
  host: process.env.HOST || "0.0.0.0",

  rpcUrl: process.env.RPC_URL || "https://base-rpc.publicnode.com",
  axisToken:
    process.env.AXIS_TOKEN_ADDRESS ||
    "0x6DBBd1910BeFC6736b818d4DcaD3ff833b9e06D7",
  axisDecimals: 18,

  payTo,
  // Treasury private key — receives buyer AXIS and pays out miners. Sensitive.
  treasuryKey,
  // Share of each buyer payment paid to the serving miner (rest = protocol fee).
  minerShare: Math.min(
    1,
    Math.max(0, Number.parseFloat(process.env.MINER_SHARE || "0.9")),
  ),
  // Flat AXIS gas-fee deducted from each payout so the treasury is reimbursed
  // for the ETH it spends on the payout tx — the miner effectively covers their
  // own gas, and the operator never loses value moving funds.
  gasFeeAxis: process.env.GAS_FEE_AXIS || "2",

  // Operator-direct fallback. If a paid job sits queued this long without a
  // distributed miner claiming it, the market serves it itself using its own AI
  // key (needs OPENAI/ANTHROPIC key set). 0 disables the fallback. This makes a
  // single request complete even when no miner is online.
  fallbackAfterSeconds: Math.max(
    0,
    Number.parseInt(process.env.OPERATOR_FALLBACK_SECONDS || "25", 10),
  ),

  // Cost-coverage auto-sell. Every paid job leaves an AXIS protocol fee in the
  // treasury; selling a bounded slice of it on the live Uniswap v4 ETH/AXIS pool
  // (Base) turns that AXIS into ETH to cover the operator's running gas cost —
  // a self-funding loop that needs NO contract change. OFF by default and
  // heavily guarded: it will NOT sell into a thin pool (price-impact guard) so
  // it can't be dumped at a bad price. Requires real pool liquidity to execute
  // (see LIQUIDITY_RUNBOOK).
  autoSell: {
    enabled: String(process.env.AUTO_SELL_ENABLED || "false") === "true",
    // Max AXIS sold per job/settlement (a hard bound on any single swap).
    maxAxisPerSell: Number.parseFloat(process.env.AUTO_SELL_MAX_AXIS || "50"),
    // Slippage tolerance for the min-out on the swap (basis points).
    slippageBps: Number.parseInt(process.env.AUTO_SELL_SLIPPAGE_BPS || "100", 10),
    // Refuse the swap if its price impact vs. spot exceeds this (basis points).
    // The main guard against selling into ~nil liquidity.
    maxImpactBps: Number.parseInt(process.env.AUTO_SELL_MAX_IMPACT_BPS || "300", 10),

    // Validator gas top-up. The AXIS→ETH sales land in the treasury; when the
    // validator wallet (the key that signs on-chain mining mints) runs low on
    // Base ETH, the treasury forwards it a fixed top-up out of that ETH so it
    // never stalls for gas. Deliberately bounded: only fires when the validator
    // is BELOW validatorMinEth, sends a fixed validatorTopUpEth, and NEVER lets
    // the treasury drop below treasuryReserveEth. Empty validatorWallet = off.
    validatorWallet: (process.env.VALIDATOR_WALLET || "").trim(),
    // Top up only when the validator's ETH balance is below this (ETH).
    validatorMinEth: process.env.VALIDATOR_MIN_ETH || "0.003",
    // How much ETH to send per top-up.
    validatorTopUpEth: process.env.VALIDATOR_TOPUP_ETH || "0.01",
    // Never send a top-up that would take the treasury's ETH below this floor.
    treasuryReserveEth: process.env.TREASURY_RESERVE_ETH || "0.005",
  },

  // Deflationary sink. A share of each job's protocol fee (paid − miner share)
  // is permanently removed from supply by transferring it to an unspendable burn
  // address. This needs NO contract change — it is a plain ERC-20 transfer — yet
  // it makes AXIS deflationary: every paid unit of real AI compute shrinks the
  // circulating supply, tying token value to genuine usage. Tune via env
  // (BURN_SHARE=0 disables; =1 burns the entire protocol fee).
  burnShare: Math.min(
    1,
    Math.max(0, Number.parseFloat(process.env.BURN_SHARE || "0.5")),
  ),
  burnAddress:
    process.env.BURN_ADDRESS || "0x000000000000000000000000000000000000dEaD",

  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: Number.parseInt(process.env.REDIS_PORT || "6379", 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },

  ai: {
    openaiKey: process.env.OPENAI_API_KEY || "",
    anthropicKey: process.env.ANTHROPIC_API_KEY || "",
    models: {
      fast: process.env.MODEL_FAST || "",
      balanced: process.env.MODEL_BALANCED || "",
      pro: process.env.MODEL_PRO || "",
    },
  },

  // OmniRoute operator inference backend (an OpenAI-compatible gateway to many
  // providers). When OMNIROUTE_URL is set the operator serves jobs by calling
  // this endpoint instead of OpenAI/Anthropic directly, which unlocks the full
  // curated model catalog below. Point OMNIROUTE_URL at the gateway base (…/v1);
  // the local default matches `omniroute` on its standard port.
  omniroute: {
    url: (process.env.OMNIROUTE_URL || "").trim(), // e.g. http://localhost:20128/v1
    apiKey: (process.env.OMNIROUTE_API_KEY || "").trim(), // optional bearer key
  },

  // Direct Cloudflare Workers AI (OpenAI-compatible). When CF_ACCOUNT_ID +
  // CF_API_TOKEN are set, the market serves inference straight from Cloudflare's
  // always-on cloud API — NO OmniRoute, NO tunnel, NO local machine. This is the
  // preferred provider (checked first) so a running compute-market on Railway is
  // fully self-contained.
  cloudflare: {
    accountId: (process.env.CF_ACCOUNT_ID || "").trim(),
    apiToken: (process.env.CF_API_TOKEN || "").trim(),
  },

  // Serve paid jobs with the operator's OmniRoute backend IMMEDIATELY, before
  // offering them to distributed miners (miners stay as the fallback if the
  // operator backend errors). Only takes effect when an operator backend is
  // configured; defaults ON so a single request always completes fast.
  operatorFirst: String(process.env.FULFILL_OPERATOR_FIRST || "true") === "true",

  // Operator revenue split — applied ONLY to jobs the operator serves itself.
  // The buyer's AXIS is sold to ETH on the live ETH/AXIS pool, then the ETH is
  // routed by these basis-point shares (must sum to 10000):
  //   validatorBps → ETH sent to the validator gas wallet (self-funds minting)
  //   treasuryBps  → ETH kept in the treasury (self-funds its own gas)
  //   buybackBps   → ETH used to buy AXIS back off the pool, then burned
  // Moves real funds, so it is OFF and dry-run by default — flip both on only
  // once the numbers look right in the logs.
  revenueSplit: {
    enabled: String(process.env.REVENUE_SPLIT_ENABLED || "false") === "true",
    dryRun: String(process.env.REVENUE_SPLIT_DRY_RUN || "true") === "true",
    validatorBps: Number.parseInt(process.env.SPLIT_VALIDATOR_BPS || "4000", 10),
    treasuryBps: Number.parseInt(process.env.SPLIT_TREASURY_BPS || "4000", 10),
    buybackBps: Number.parseInt(process.env.SPLIT_BUYBACK_BPS || "2000", 10),
  },

  pricing: {
    fast: process.env.PRICE_FAST_AXIS || "10",
    balanced: process.env.PRICE_BALANCED_AXIS || "50",
    pro: process.env.PRICE_PRO_AXIS || "250",
  },

  // Token-based pricing (OmniRoute catalog). Each paid request grants up to
  // `budgetTokens` of output, priced at `discount` × the benchmarked provider's
  // real per-token cost, converted to AXIS at `axisUsd`. This makes AXIS compute
  // a transparent, cheaper-than-Anthropic deal (default 50% off). Keep `axisUsd`
  // roughly current with the market (live AXIS≈$0.0062 at ETH≈$3k); all tunable.
  //   price_axis = max(minAxis, round( refUsdPer1M/1e6 * budgetTokens * discount / axisUsd ))
  tokenPricing: {
    budgetTokens: Number.parseInt(process.env.OUTPUT_TOKEN_BUDGET || "8000", 10),
    discount: Math.min(1, Math.max(0, Number.parseFloat(process.env.PRICE_DISCOUNT || "0.5"))),
    axisUsd: Number.parseFloat(process.env.AXIS_USD_PRICE || "0.0062"),
    minAxis: Number.parseFloat(process.env.MIN_PRICE_AXIS || "1"),
  },
};
