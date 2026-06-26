"use strict";

const { ethers } = require("ethers");

/**
 * Cryptographic helpers for the verification pipeline.
 */

/**
 * Builds the canonical message a miner must sign for a submission. The exact
 * same construction is used by the gateway and the bots so signatures verify
 * consistently across all entry points.
 *
 * @param {object} s Submission fields.
 * @returns {string} Canonical message string.
 */
function buildSubmissionMessage(s) {
  return [
    "AXIS-POAIW-SUBMISSION",
    s.wallet_address.toLowerCase(),
    s.work_type,
    s.input_hash,
    s.output_hash,
    String(s.timestamp),
  ].join("|");
}

/**
 * Verifies that `signature` over the canonical submission message was produced
 * by `wallet_address`.
 *
 * @returns {boolean} true if the recovered signer matches the claimed wallet.
 */
function verifySubmissionSignature(submission) {
  try {
    const message = buildSubmissionMessage(submission);
    const recovered = ethers.verifyMessage(message, submission.signature);
    return recovered.toLowerCase() === submission.wallet_address.toLowerCase();
  } catch (_) {
    return false;
  }
}

/**
 * keccak256 commitment of arbitrary string/byte data.
 * @param {string} data
 * @returns {string} 0x-prefixed 32-byte hash.
 */
function commit(data) {
  return ethers.keccak256(ethers.toUtf8Bytes(typeof data === "string" ? data : JSON.stringify(data)));
}

/**
 * Validates that `output_hash` is the exact keccak256 commitment of
 * `output_data` (whitepaper section 5.2 — cryptographic commitment of outputs).
 *
 * @returns {boolean}
 */
function verifyOutputCommitment(outputData, outputHash) {
  if (!outputHash) return false;
  const computed = commit(outputData);
  return computed.toLowerCase() === String(outputHash).toLowerCase();
}

module.exports = {
  buildSubmissionMessage,
  verifySubmissionSignature,
  commit,
  verifyOutputCommitment,
};
