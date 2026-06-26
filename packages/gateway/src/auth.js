"use strict";

const { ethers } = require("ethers");
const config = require("./config");

/**
 * Signature verification for the gateway. Two flavours:
 *
 *  - Submission signatures: the SAME canonical message the engine verifies
 *    (so a body that passes the gateway also passes the engine).
 *  - Auth-header signatures: a lightweight per-request signed challenge used to
 *    authenticate read endpoints, of the form:
 *        AXIS-GATEWAY-AUTH|<wallet lowercased>|<timestamp ms>
 */

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

function buildAuthMessage(wallet, timestamp) {
  return ["AXIS-GATEWAY-AUTH", String(wallet).toLowerCase(), String(timestamp)].join("|");
}

/**
 * Verifies a submission body's signature against its wallet_address.
 */
function verifySubmission(body) {
  try {
    if (!body || !body.signature || !body.wallet_address) return false;
    const recovered = ethers.verifyMessage(buildSubmissionMessage(body), body.signature);
    return recovered.toLowerCase() === String(body.wallet_address).toLowerCase();
  } catch (_) {
    return false;
  }
}

/**
 * Verifies an auth-header signed challenge. Returns the wallet on success or
 * null on failure. Enforces a freshness window to prevent replay.
 */
function verifyAuthHeaders(headers) {
  try {
    const wallet = headers["x-wallet-address"];
    const signature = headers["x-signature"];
    const timestamp = headers["x-timestamp"];
    if (!wallet || !signature || !timestamp) return null;

    const ageMs = Date.now() - Number(timestamp);
    if (!Number.isFinite(ageMs) || ageMs < -60000 || ageMs > config.authMaxAgeSeconds * 1000) {
      return null;
    }
    const recovered = ethers.verifyMessage(buildAuthMessage(wallet, timestamp), signature);
    return recovered.toLowerCase() === String(wallet).toLowerCase() ? wallet.toLowerCase() : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  buildSubmissionMessage,
  buildAuthMessage,
  verifySubmission,
  verifyAuthHeaders,
};
