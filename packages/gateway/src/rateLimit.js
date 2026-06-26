"use strict";

const redis = require("./redis");
const config = require("./config");

/**
 * DDoS protection + cross-channel rate limiting backed by Redis.
 *
 *  - IP-level: 100 requests per IP per minute (sliding 60s window).
 *  - Wallet-level: 1 submission per 60 seconds, keyed by wallet ONLY (so a
 *    wallet submitting via Telegram cannot also submit via WhatsApp within the
 *    same window).
 *  - Repeated violations trip an automatic temporary ban.
 */

const IP_KEY = (ip) => `gw:ip:${ip}`;
const WALLET_KEY = (w) => `gw:wallet:submit:${w.toLowerCase()}`;
const VIOLATION_KEY = (id) => `gw:violations:${id}`;
const BAN_KEY = (id) => `gw:ban:${id}`;

/**
 * IP request counter. Returns { allowed, count, limit }.
 */
async function checkIpRate(ip) {
  const key = IP_KEY(ip);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return { allowed: count <= config.ipRatePerMinute, count, limit: config.ipRatePerMinute };
}

/**
 * Wallet submission cooldown (cross-channel). Returns { allowed, retryAfter }.
 */
async function checkWalletCooldown(wallet) {
  const key = WALLET_KEY(wallet);
  const exists = await redis.exists(key);
  if (exists) {
    const ttl = await redis.ttl(key);
    return { allowed: false, retryAfter: ttl > 0 ? ttl : config.walletSubmitCooldownSeconds };
  }
  return { allowed: true, retryAfter: 0 };
}

/**
 * Marks a wallet as having just submitted, opening its cooldown window.
 */
async function markWalletSubmission(wallet) {
  await redis.set(
    WALLET_KEY(wallet),
    String(Date.now()),
    "EX",
    config.walletSubmitCooldownSeconds
  );
}

/**
 * Records a violation for an identifier (ip or wallet) and applies a temporary
 * ban once the threshold is exceeded. Returns true if now banned.
 */
async function recordViolation(id) {
  const key = VIOLATION_KEY(id);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, config.banSeconds);
  if (count >= config.banThreshold) {
    await redis.set(BAN_KEY(id), "1", "EX", config.banSeconds);
    return true;
  }
  return false;
}

/**
 * Whether an identifier is currently banned.
 */
async function isBanned(id) {
  return (await redis.exists(BAN_KEY(id))) === 1;
}

module.exports = {
  checkIpRate,
  checkWalletCooldown,
  markWalletSubmission,
  recordViolation,
  isBanned,
};
