"use strict";

const { ethers } = require("ethers");
const redis = require("./redis");
const config = require("./config");

/**
 * Nonce enforcement. Every submission carries a nonce derived from
 * (wallet + timestamp + block_height). The gateway records each seen nonce in
 * Redis; a duplicate nonce is rejected immediately and the wallet is flagged.
 */

const NONCE_KEY = (nonce) => `gw:nonce:${nonce}`;

/**
 * Computes the canonical nonce for a submission. Clients should send this same
 * value; the gateway recomputes and compares to prevent client-side spoofing.
 */
function computeNonce(wallet, timestamp, blockHeight) {
  return ethers.keccak256(
    ethers.toUtf8Bytes(`${String(wallet).toLowerCase()}|${timestamp}|${blockHeight}`)
  );
}

/**
 * Validates and consumes a nonce. Returns:
 *   { ok: true }                              first use
 *   { ok: false, reason }                     malformed or duplicate
 */
async function consumeNonce(body) {
  const { wallet_address, timestamp, block_height, nonce } = body;
  if (nonce === undefined || timestamp === undefined || block_height === undefined) {
    return { ok: false, reason: "missing nonce/timestamp/block_height" };
  }

  const expected = computeNonce(wallet_address, timestamp, block_height);
  if (String(nonce).toLowerCase() !== expected.toLowerCase()) {
    return { ok: false, reason: "nonce does not match wallet+timestamp+block_height" };
  }

  // SET NX — first writer wins; a second identical nonce is a duplicate.
  const set = await redis.set(NONCE_KEY(expected), "1", "EX", config.nonceTtlSeconds, "NX");
  if (set === null) {
    return { ok: false, reason: "duplicate nonce" };
  }
  return { ok: true, nonce: expected };
}

module.exports = { computeNonce, consumeNonce };
