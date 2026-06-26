"use strict";

const { ethers } = require("ethers");

/**
 * Wallet + signing helpers shared by the Telegram bot and WhatsApp agent.
 *
 * Messaging interfaces are gateways, not custodians (whitepaper section 8). For
 * a fully working end-to-end demo, each channel user is given a deterministic,
 * reproducible mining wallet derived from a server secret + channel + user id.
 * Because the derivation is deterministic, the user can re-derive / export the
 * exact same key off-platform — the bot never holds exclusive custody. All
 * on-chain rewards accrue to this mining wallet address.
 */

/**
 * Deterministically derives a user's mining wallet.
 * @param {string} secret BOT_SIGNER_SECRET (per-deployment server secret).
 * @param {string} channel "telegram" | "whatsapp".
 * @param {string|number} userId Channel user id.
 * @returns {ethers.Wallet}
 */
function deriveWallet(secret, channel, userId) {
  const pk = ethers.keccak256(ethers.toUtf8Bytes(`${secret}|${channel}|${userId}`));
  return new ethers.Wallet(pk);
}

/**
 * keccak256 commitment identical to the engine's `commit()` so output hashes
 * match exactly across services.
 */
function commit(data) {
  const s = typeof data === "string" ? data : JSON.stringify(data);
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

/** Canonical submission message (must match engine + gateway). */
function buildSubmissionMessage(s) {
  return [
    "AXIS-POAIW-SUBMISSION",
    String(s.wallet_address).toLowerCase(),
    s.work_type,
    s.input_hash,
    s.output_hash,
    String(s.timestamp),
  ].join("|");
}

/** Canonical gateway auth message (must match gateway). */
function buildAuthMessage(wallet, timestamp) {
  return ["AXIS-GATEWAY-AUTH", String(wallet).toLowerCase(), String(timestamp)].join("|");
}

/** Nonce = keccak256(wallet|timestamp|block_height) (must match gateway). */
function computeNonce(wallet, timestamp, blockHeight) {
  return ethers.keccak256(
    ethers.toUtf8Bytes(`${String(wallet).toLowerCase()}|${timestamp}|${blockHeight}`)
  );
}

/**
 * Builds a fully-signed gateway submission body from a user's output data.
 * @param {ethers.Wallet} wallet The user's mining wallet.
 * @param {string} workType
 * @param {string} outputDataString The exact string that will be hashed + sent.
 * @param {object} opts { blockHeight, channel, inputSeed }
 */
async function buildSubmission(wallet, workType, outputDataString, opts = {}) {
  const timestamp = Date.now();
  const blockHeight = opts.blockHeight != null ? opts.blockHeight : 0;
  const inputHash = commit(opts.inputSeed || `input:${workType}:${timestamp}`);
  const outputHash = commit(outputDataString);

  const base = {
    wallet_address: wallet.address,
    work_type: workType,
    input_hash: inputHash,
    output_hash: outputHash,
    timestamp,
  };
  const signature = await wallet.signMessage(buildSubmissionMessage(base));

  return {
    ...base,
    output_data: outputDataString,
    block_height: blockHeight,
    nonce: computeNonce(wallet.address, timestamp, blockHeight),
    signature,
    channel: opts.channel || "api",
  };
}

/**
 * Produces signed gateway auth headers for read endpoints.
 * @param {ethers.Wallet} wallet
 */
async function buildAuthHeaders(wallet) {
  const timestamp = Date.now();
  const signature = await wallet.signMessage(buildAuthMessage(wallet.address, timestamp));
  return {
    "x-wallet-address": wallet.address,
    "x-timestamp": String(timestamp),
    "x-signature": signature,
  };
}

module.exports = {
  deriveWallet,
  commit,
  buildSubmissionMessage,
  buildAuthMessage,
  computeNonce,
  buildSubmission,
  buildAuthHeaders,
};
