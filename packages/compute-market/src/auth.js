"use strict";

const { ethers } = require("ethers");

const MAX_SKEW_MS = 5 * 60 * 1000; // signature must be recent

/**
 * Authenticates a miner (compute provider) from signed headers. The miner signs
 * `AXIS-COMPUTE-MINER|<addr>|<timestamp>` with their wallet; we recover the
 * address and use it as both their identity and their AXIS payout address.
 *
 * @returns {string|null} the checksummed miner address, or null if invalid.
 */
function verifyMiner(headers) {
  const addr = headers["x-wallet-address"];
  const ts = headers["x-timestamp"];
  const sig = headers["x-signature"];
  if (!addr || !ts || !sig) return null;
  if (!Number.isFinite(Number(ts)) || Math.abs(Date.now() - Number(ts)) > MAX_SKEW_MS) {
    return null;
  }
  const message = `AXIS-COMPUTE-MINER|${String(addr).toLowerCase()}|${ts}`;
  try {
    const recovered = ethers.verifyMessage(message, sig);
    if (recovered.toLowerCase() === String(addr).toLowerCase()) return recovered;
  } catch (_) {
    /* bad signature */
  }
  return null;
}

/**
 * Verifies that `payer` signed `AXIS-COMPUTE-PAY|<payer>|<txHash>`, proving the
 * buyer who is submitting this request is the same wallet that made the payment.
 * Combined with `verifyAxisPayment(..., payer)` (which checks the on-chain
 * Transfer `from`), this stops anyone from claiming another wallet's payment by
 * its tx hash.
 *
 * @returns {boolean} true when the signature is valid for `payer` + `txHash`.
 */
function verifyPayer(payer, txHash, signature) {
  if (!payer || !txHash || !signature) return false;
  if (!ethers.isAddress(payer)) return false;
  const message = `AXIS-COMPUTE-PAY|${String(payer).toLowerCase()}|${String(txHash).toLowerCase()}`;
  try {
    const recovered = ethers.verifyMessage(message, signature);
    return recovered.toLowerCase() === String(payer).toLowerCase();
  } catch (_) {
    return false;
  }
}

module.exports = { verifyMiner, verifyPayer };
