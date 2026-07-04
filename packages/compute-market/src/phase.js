"use strict";

const { ethers } = require("ethers");
const config = require("./config");
const { provider } = require("./payments");

/**
 * Genesis gate. The compute market — and everything built on it (miner payouts,
 * the website buyer page) — only activates AFTER 25% of the supply is mined
 * (the end of the Genesis Phase). Until then the marketplace is dormant: mining
 * is the easy on-ramp; once the network matures, the real AI economy switches on.
 *
 * Reads the live AXIS token's totalMinted / MAX_SUPPLY (no contract changes).
 */
const TOKEN_ABI = [
  "function totalMinted() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
];

const token = new ethers.Contract(config.axisToken, TOKEN_ABI, provider);

// % of supply that must be mined before the compute market (and its burn sink)
// activates. Env-tunable so the operator can switch the AI economy — real AXIS
// demand + deflationary burns — on sooner than 25% to build value earlier.
const GENESIS_THRESHOLD_PCT = Number.parseFloat(
  process.env.GENESIS_THRESHOLD_PCT || "25",
);
let cache = { ts: 0, postGenesis: false, percent: 0 };

/** Returns { postGenesis, percent } — cached ~60s to avoid hammering the RPC. */
async function getPhase() {
  const now = Date.now();
  if (now - cache.ts < 60_000) return cache;
  try {
    const [minted, max] = await Promise.all([
      token.totalMinted(),
      token.MAX_SUPPLY(),
    ]);
    const percent = max > 0n ? Number((minted * 10000n) / max) / 100 : 0;
    cache = {
      ts: now,
      postGenesis: percent >= GENESIS_THRESHOLD_PCT,
      percent,
    };
  } catch (_e) {
    cache = { ...cache, ts: now }; // keep last known on RPC hiccup
  }
  return cache;
}

module.exports = { getPhase, GENESIS_THRESHOLD_PCT };
