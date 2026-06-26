"use strict";

const redis = require("../redis/client");
const config = require("../config");

/**
 * Wallet cooldown tracking. A rejected submission applies a 60-second (default)
 * cooldown so abusive wallets cannot spam the verifier. Cooldown is keyed by
 * wallet only — consistent across all channels via the shared Redis instance.
 */

const KEY = (wallet) => `cooldown:${wallet.toLowerCase()}`;

/**
 * Applies a cooldown to a wallet.
 * @param {string} wallet
 * @param {number} [seconds] Defaults to config.verification.cooldownSeconds.
 */
async function applyCooldown(wallet, seconds = config.verification.cooldownSeconds) {
  const until = Date.now() + seconds * 1000;
  await redis.set(KEY(wallet), String(until), "EX", seconds);
  return until;
}

/**
 * Returns remaining cooldown in seconds (0 if none).
 * @param {string} wallet
 */
async function getCooldown(wallet) {
  const ttl = await redis.ttl(KEY(wallet));
  return ttl > 0 ? ttl : 0;
}

/**
 * Whether a wallet is currently in cooldown.
 */
async function isOnCooldown(wallet) {
  return (await getCooldown(wallet)) > 0;
}

module.exports = { applyCooldown, getCooldown, isOnCooldown };
