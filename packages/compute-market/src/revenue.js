"use strict";

const { ethers } = require("ethers");
const config = require("./config");
const redis = require("./redis");
const costcoverage = require("./costcoverage");
const { burnAxis, canPayout } = require("./payout");

/**
 * Operator revenue split.
 *
 * When the operator serves a job itself (via the OmniRoute backend), the buyer's
 * AXIS is 100% treasury revenue — there is no distributed miner to pay. This
 * module turns that AXIS into a self-funding loop:
 *
 *   • sell the validator+treasury slice of the AXIS → ETH on the live pool,
 *   • send the validator its ETH share (self-funds on-chain minting gas),
 *   • leave the treasury its ETH share (self-funds its own gas),
 *   • burn the buyback slice of AXIS (permanent supply cut).
 *
 * Shares are basis points from config.revenueSplit (default 40/40/20).
 *
 * Because buyers pay in AXIS, a literal "buy AXIS with the revenue" is circular,
 * so the deflationary 20% is realised as a direct burn of that AXIS — economically
 * identical to buy-and-burn for AXIS-sourced revenue, minus two wasted swaps. A
 * true on-chain ETH→AXIS buyback (BUYBACK_MODE=swap) is a validated follow-up;
 * until then it falls back to the burn.
 *
 * Safety: this moves real funds, so it is OFF (config.revenueSplit.enabled) and
 * dry-run (config.revenueSplit.dryRun) by default. It never throws — every leg is
 * best-effort and returns a structured result the caller can log.
 */

const BPS = 10000n;

/** Validates the configured split. Returns null if OK, or an error string. */
function splitError() {
  const { validatorBps, treasuryBps, buybackBps } = config.revenueSplit;
  for (const [k, v] of [
    ["validatorBps", validatorBps],
    ["treasuryBps", treasuryBps],
    ["buybackBps", buybackBps],
  ]) {
    if (!Number.isInteger(v) || v < 0) return `${k} must be a non-negative integer`;
  }
  if (validatorBps + treasuryBps + buybackBps !== 10000)
    return `split bps must sum to 10000 (got ${validatorBps}+${treasuryBps}+${buybackBps})`;
  return null;
}

/** AXIS-wei amounts for each slice of a `paidWei` payment. */
function sliceAmounts(paidWei) {
  const p = BigInt(paidWei);
  const { validatorBps, treasuryBps } = config.revenueSplit;
  const validatorAxis = (p * BigInt(validatorBps)) / BPS;
  const treasuryAxis = (p * BigInt(treasuryBps)) / BPS;
  const buybackAxis = p - validatorAxis - treasuryAxis; // remainder → exact
  return { validatorAxis, treasuryAxis, buybackAxis, sellAxis: validatorAxis + treasuryAxis };
}

async function incrBurned(axisStr) {
  try {
    await redis.incrbyfloat("cm:burned:axis", axisStr);
  } catch (_) {
    /* best-effort counter */
  }
}

/**
 * Settles the operator's revenue for a single served job.
 * @param {bigint|string} paidWei  AXIS (wei) the buyer paid into the treasury.
 * @param {string} memo            Log tag, e.g. "job:<id>".
 */
async function settleOperatorRevenue(paidWei, memo = "") {
  const paid = BigInt(paidWei || "0");
  if (paid <= 0n) return { settled: false, reason: "zero payment" };

  // Feature off → preserve the legacy cost-coverage behavior (bounded auto-sell
  // to refill treasury gas + fixed validator top-up). Both are no-ops unless
  // AUTO_SELL_ENABLED, so this is safe and unchanged from before.
  if (!config.revenueSplit.enabled) {
    try {
      await costcoverage.coverCost(paid, memo);
      await costcoverage.topUpValidator(memo);
    } catch (_) {
      /* best-effort */
    }
    return { settled: false, mode: "legacy", reason: "revenue split disabled" };
  }

  const err = splitError();
  if (err) {
    // eslint-disable-next-line no-console
    console.warn(`[split] misconfigured, skipping (${memo}): ${err}`);
    return { settled: false, reason: err };
  }

  const { validatorAxis, treasuryAxis, buybackAxis, sellAxis } = sliceAmounts(paid);
  const { validatorBps, treasuryBps } = config.revenueSplit;
  const validatorWallet = config.autoSell.validatorWallet;
  const reserveWei = ethers.parseEther(String(config.autoSell.treasuryReserveEth));

  // Per-swap safety cap (AUTO_SELL_MAX_AXIS) also bounds how much of the payment
  // converts to ETH in one job — the rest stays as treasury AXIS for later.
  const capWei = ethers.parseUnits(String(config.autoSell.maxAxisPerSell), 18);
  const sellCapped = sellAxis > capWei ? capWei : sellAxis;

  // Live quote for the ETH the sell would yield, and the validator's ETH share.
  let quotedEthWei = 0n;
  try {
    quotedEthWei = await costcoverage.quoteSell(sellCapped);
  } catch (e) {
    quotedEthWei = 0n;
  }
  const denom = BigInt(validatorBps + treasuryBps) || 1n;
  const validatorEthWei = (quotedEthWei * BigInt(validatorBps)) / denom;

  const fmt = (wei, unit = 18) => ethers.formatUnits(wei, unit);
  const projection = {
    paid_axis: fmt(paid),
    sell_axis: fmt(sellCapped),
    quoted_eth: fmt(quotedEthWei),
    validator: { axis: fmt(validatorAxis), eth: fmt(validatorEthWei), wallet: validatorWallet || null },
    treasury: { axis: fmt(treasuryAxis), eth: fmt(quotedEthWei - validatorEthWei) },
    buyback_burn_axis: fmt(buybackAxis),
  };

  if (config.revenueSplit.dryRun) {
    // eslint-disable-next-line no-console
    console.log(`[split] DRY-RUN (${memo}) ${JSON.stringify(projection)}`);
    return { settled: false, mode: "dry-run", projection };
  }

  // ---- Real execution (enabled && !dryRun). Every leg is best-effort. ---- //
  const result = { settled: true, mode: "live", memo, projection, legs: {} };

  // 1) Sell the validator+treasury AXIS slice → ETH (lands in the treasury).
  try {
    result.legs.sell = await costcoverage.sellAxisForEth(sellCapped, `${memo}:split-sell`);
  } catch (e) {
    result.legs.sell = { sold: false, reason: e.message };
  }

  // 2) Forward the validator its ETH share (reserve-protected).
  if (result.legs.sell?.sold && validatorWallet && validatorEthWei > 0n) {
    try {
      result.legs.validator = await costcoverage.sendEth(
        validatorWallet,
        validatorEthWei,
        `${memo}:validator`,
        reserveWei,
      );
    } catch (e) {
      result.legs.validator = { sent: false, reason: e.message };
    }
  } else {
    result.legs.validator = {
      sent: false,
      reason: !validatorWallet ? "no validator wallet" : "sell did not complete",
    };
  }
  // The treasury simply keeps the remaining ETH from the sell — no action needed.

  // 3) Buyback slice → burn (permanent supply cut). Plain ERC-20 transfer, so no
  //    swap/price-impact risk; burn the full slice regardless of the sell cap.
  if (buybackAxis > 0n && canPayout()) {
    try {
      const tx = await burnAxis(buybackAxis);
      const burned = fmt(buybackAxis);
      await incrBurned(burned);
      result.legs.burn = { burned: true, tx, axis: burned };
    } catch (e) {
      result.legs.burn = { burned: false, reason: e.message };
    }
  } else {
    result.legs.burn = { burned: false, reason: "nothing to burn / treasury not configured" };
  }

  // eslint-disable-next-line no-console
  console.log(`[split] LIVE (${memo}) ${JSON.stringify(result.legs)}`);
  return result;
}

module.exports = { settleOperatorRevenue, splitError, sliceAmounts };
