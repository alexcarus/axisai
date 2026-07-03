"use strict";

const { ethers } = require("ethers");
const config = require("./config");

// keccak256("Transfer(address,address,uint256)") — the ERC-20 Transfer topic.
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const provider = new ethers.JsonRpcProvider(config.rpcUrl);

// Confirmations a payment must have before it's accepted. 1 = "mined" (the
// default; a receipt already implies inclusion, so this is the current UX with
// no added wait). Raise it (e.g. 2–3) for reorg protection on higher-value
// deployments — the verifier briefly waits for the extra blocks server-side so
// the single-shot client flow still succeeds.
const MIN_CONFIRMATIONS = Math.max(
  1,
  Number.parseInt(process.env.PAYMENT_MIN_CONFIRMATIONS || "1", 10),
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Confirmations for a receipt (inclusion block counts as 1). */
async function confirmationsFor(receipt) {
  const current = await provider.getBlockNumber();
  return current - receipt.blockNumber + 1;
}

/**
 * Verifies on-chain that `txHash` transferred at least `minAxisWei` of the live
 * AXIS token to the marketplace `payTo` address. Reads the token's Transfer
 * logs only — it never touches or changes the contract. Returns the total AXIS
 * paid (wei), or throws on any failure.
 *
 * @param {string} txHash      The payment transaction hash.
 * @param {bigint} minAxisWei  Minimum AXIS (wei) that must reach the treasury.
 * @param {string} [expectedFrom] When given, ONLY transfers whose `from` matches
 *        this address are counted. This binds a payment to the wallet that made
 *        it, so a request can't claim someone else's payment by tx hash
 *        (front-running / theft-of-service).
 */
async function verifyAxisPayment(txHash, minAxisWei, expectedFrom) {
  if (!config.payTo) throw new Error("marketplace payTo not configured");

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("transaction not found (not yet mined?)");
  if (receipt.status !== 1) throw new Error("transaction reverted");

  // Require the payment to be sufficiently confirmed (reorg protection). At the
  // default of 1 this is a no-op; when raised, wait briefly for the extra blocks
  // so a freshly-mined payment isn't rejected on timing.
  if (MIN_CONFIRMATIONS > 1) {
    let confs = await confirmationsFor(receipt);
    for (let i = 0; i < 8 && confs < MIN_CONFIRMATIONS; i++) {
      await sleep(1500);
      confs = await confirmationsFor(receipt);
    }
    if (confs < MIN_CONFIRMATIONS) {
      throw new Error(
        `payment has ${confs}/${MIN_CONFIRMATIONS} confirmations — retry shortly`,
      );
    }
  }

  const token = config.axisToken.toLowerCase();
  const payTo = config.payTo.toLowerCase();
  const from = expectedFrom ? String(expectedFrom).toLowerCase() : null;

  let paid = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token) continue;
    if (!log.topics || log.topics[0] !== TRANSFER_TOPIC) continue;
    // topics[1] = indexed `from`, topics[2] = indexed `to` (last 20 bytes).
    const to = `0x${log.topics[2].slice(26)}`.toLowerCase();
    if (to !== payTo) continue;
    if (from) {
      const logFrom = `0x${log.topics[1].slice(26)}`.toLowerCase();
      if (logFrom !== from) continue; // only count the payer's own transfer
    }
    paid += ethers.toBigInt(log.data);
  }

  if (paid < minAxisWei) {
    throw new Error(
      `insufficient AXIS: paid ${ethers.formatEther(paid)}, need ${ethers.formatEther(minAxisWei)}`,
    );
  }
  return paid;
}

module.exports = { verifyAxisPayment, provider };
