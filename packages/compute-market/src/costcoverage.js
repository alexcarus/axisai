"use strict";

const { ethers } = require("ethers");
const config = require("./config");
const { signer, provider } = require("./payout");

/**
 * Cost-coverage auto-sell.
 *
 * When the operator serves jobs directly, the buyer's AXIS accumulates in the
 * treasury. This module sells a BOUNDED slice of that AXIS for ETH on the
 * Uniswap v4 ETH/AXIS pool (Base), so the treasury refills the ETH it spends on
 * gas (payouts, burns) — a self-funding loop.
 *
 * Safety (this moves real funds, so it is deliberately timid):
 *   - OFF unless AUTO_SELL_ENABLED=true.
 *   - Never sells more than AUTO_SELL_MAX_AXIS per call.
 *   - Gets a live quote and REFUSES if the price impact vs. spot exceeds
 *     AUTO_SELL_MAX_IMPACT_BPS — so it can NOT dump into a thin pool.
 *   - Enforces a min-out (slippage bound) on the swap itself.
 *   - Shares the treasury NonceManager so it can't race payout nonces.
 */

// Uniswap v4 infrastructure + tokens on Base (mirrors mpp-main/src/lib/uniswap-v4.ts).
const AXIS = "0x6DBBd1910BeFC6736b818d4DcaD3ff833b9e06D7";
const ETH = "0x0000000000000000000000000000000000000000"; // native ETH (v4 currency0)
const STATE_VIEW = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71";
const V4_QUOTER = "0x0d5e0f971ed27fbff6c2837bf31316121532048d";
const UNIVERSAL_ROUTER = "0x6ff5693b99212da76ad316178a184ab56d299b43";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const POOL_ID = "0x4425a476a588b210c430062cfa30a7adc26fae4dbb1ddb2b8db488bbde16255a";
const POOL_KEY = [ETH, AXIS, 10000, 200, ETH]; // currency0=ETH, currency1=AXIS, no hooks
const POOLKEY_T = "tuple(address,address,uint24,int24,address)";

const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = (1n << 48n) - 1n;
const CMD_V4_SWAP = "0x10";
const ACTIONS_EXACT_IN = "0x060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL

const coder = ethers.AbiCoder.defaultAbiCoder();

const QUOTER_ABI = [
  "function quoteExactInputSingle((" +
    "(address,address,uint24,int24,address) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData" +
    ") params) returns (uint256 amountOut, uint256 gasEstimate)",
];
const STATE_VIEW_ABI = [
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const PERMIT2_ABI = [
  "function allowance(address,address,address) view returns (uint160,uint48,uint48)",
  "function approve(address,address,uint160,uint48)",
];
const ROUTER_ABI = [
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
];

function enabled() {
  return config.autoSell.enabled && !!signer;
}

/** Live spot price: ETH per 1 AXIS, from the pool's sqrtPriceX96. */
async function spotEthPerAxis() {
  const sv = new ethers.Contract(STATE_VIEW, STATE_VIEW_ABI, provider);
  const [sqrtP] = await sv.getSlot0(POOL_ID);
  // currency0=ETH, currency1=AXIS (both 18dp) → ratio = AXIS per ETH.
  const axisPerEth = (Number(sqrtP) / 2 ** 96) ** 2;
  return axisPerEth > 0 ? 1 / axisPerEth : 0; // ETH per AXIS
}

/** Read-only quote for selling `axisWei` AXIS → ETH (wei, 18dp). */
async function quoteSell(axisWei) {
  const quoter = new ethers.Contract(V4_QUOTER, QUOTER_ABI, provider);
  // Sell AXIS (currency1) for ETH (currency0): zeroForOne = false.
  const params = [POOL_KEY, false, axisWei, "0x"];
  const [amountOut] = await quoter.quoteExactInputSingle.staticCall(params);
  return amountOut; // ETH wei
}

/**
 * Evaluates a prospective sell without executing: returns the quote, the implied
 * price impact vs. spot, and whether the guards would allow it. Safe to call
 * anytime (read-only) — used by the dry-run and before every real sell.
 */
async function evaluate(axisWei) {
  const capWei = ethers.parseUnits(String(config.autoSell.maxAxisPerSell), 18);
  const amountWei = axisWei > capWei ? capWei : axisWei;
  if (amountWei <= 0n) return { ok: false, reason: "zero amount" };

  let spot;
  let outWei;
  try {
    [spot, outWei] = await Promise.all([spotEthPerAxis(), quoteSell(amountWei)]);
  } catch (e) {
    return { ok: false, reason: `quote failed (thin/no liquidity?): ${e.shortMessage || e.message}` };
  }

  const axis = Number(ethers.formatUnits(amountWei, 18));
  const expectedEth = axis * spot; // at spot, before fee/impact
  const gotEth = Number(ethers.formatUnits(outWei, 18));
  const impactBps =
    expectedEth > 0 ? Math.round(((expectedEth - gotEth) / expectedEth) * 10000) : 10000;

  const okImpact = impactBps <= config.autoSell.maxImpactBps;
  const minOut = (outWei * BigInt(10000 - config.autoSell.slippageBps)) / 10000n;

  return {
    ok: okImpact,
    reason: okImpact ? "ok" : `price impact ${impactBps}bps > max ${config.autoSell.maxImpactBps}bps (thin liquidity)`,
    amountAxisWei: amountWei,
    axis,
    spot,
    quotedEth: gotEth,
    impactBps,
    minOutWei: minOut,
  };
}

/** Ensures the Universal Router can pull AXIS via Permit2 (one-time approvals). */
async function ensureAllowances(amountWei) {
  const owner = config.payTo;
  const axis = new ethers.Contract(AXIS, ERC20_ABI, signer);
  const erc20Allow = await axis.allowance(owner, PERMIT2);
  if (erc20Allow < amountWei) {
    await (await axis.approve(PERMIT2, ethers.MaxUint256)).wait();
  }
  const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, signer);
  const [amt, exp] = await permit2.allowance(owner, AXIS, UNIVERSAL_ROUTER);
  const now = Math.floor(Date.now() / 1000);
  if (amt < amountWei || Number(exp) < now) {
    await (await permit2.approve(AXIS, UNIVERSAL_ROUTER, MAX_UINT160, MAX_UINT48)).wait();
  }
}

// Serialize sells so approvals + swaps don't interleave on the shared signer.
let chain = Promise.resolve();

/**
 * Sells a bounded slice of AXIS to ETH to refill the treasury's gas. Returns a
 * result object; never throws. No-op (with a reason) unless enabled and the
 * guards pass.
 *
 * @param {bigint} axisWei  AXIS available to draw from (e.g. the job payment).
 * @param {string} memo     Context tag for logs.
 */
async function coverCost(axisWei, memo = "") {
  if (!enabled()) return { sold: false, reason: "auto-sell disabled" };
  const run = chain.then(() => _coverCost(BigInt(axisWei), memo));
  chain = run.catch(() => {});
  return run;
}

/**
 * Tops the validator wallet's Base ETH back up out of the treasury's ETH (which
 * the auto-sell refills). Serialized on the same signer chain as the sells so it
 * can't race a swap/payout nonce. Bounded and best-effort — never throws.
 *
 * Fires ONLY when the validator is below `validatorMinEth`, sends a fixed
 * `validatorTopUpEth`, and refuses if it would drop the treasury below
 * `treasuryReserveEth`. A missing/invalid/self validator wallet is a silent
 * no-op, so this is safe to call after every settlement.
 */
async function topUpValidator(memo = "") {
  if (!enabled()) return { funded: false, reason: "auto-sell disabled" };
  const run = chain.then(() => _topUpValidator(memo));
  chain = run.catch(() => {});
  return run;
}

async function _topUpValidator(memo) {
  const to = config.autoSell.validatorWallet;
  if (!to || !ethers.isAddress(to)) return { funded: false, reason: "no validator wallet" };
  const treasury = config.payTo;
  if (!treasury || to.toLowerCase() === treasury.toLowerCase())
    return { funded: false, reason: "validator == treasury" };

  const minEth = ethers.parseEther(String(config.autoSell.validatorMinEth));
  const topUp = ethers.parseEther(String(config.autoSell.validatorTopUpEth));
  const reserve = ethers.parseEther(String(config.autoSell.treasuryReserveEth));
  if (topUp <= 0n) return { funded: false, reason: "top-up amount is zero" };

  let valBal;
  let treBal;
  try {
    [valBal, treBal] = await Promise.all([
      provider.getBalance(to),
      provider.getBalance(treasury),
    ]);
  } catch (e) {
    return { funded: false, reason: `balance read failed: ${e.shortMessage || e.message}` };
  }

  if (valBal >= minEth) return { funded: false, reason: "validator already funded" };
  // Keep enough ETH in the treasury for its own gas + the reserve floor.
  if (treBal < reserve + topUp) return { funded: false, reason: "treasury ETH at reserve floor" };

  try {
    const tx = await signer.sendTransaction({ to, value: topUp });
    const receipt = await tx.wait();
    const eth = ethers.formatEther(topUp);
    // eslint-disable-next-line no-console
    console.log(`[autosell] topped up validator ${to} with ${eth} ETH (${memo}) tx ${receipt.hash}`);
    return { funded: true, tx: receipt.hash, eth };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[autosell] validator top-up failed (${memo}): ${e.shortMessage || e.message}`);
    return { funded: false, reason: `top-up failed: ${e.shortMessage || e.message}` };
  }
}

async function _coverCost(axisWei, memo) {
  const ev = await evaluate(axisWei);
  if (!ev.ok) {
    // eslint-disable-next-line no-console
    console.log(`[autosell] skip (${memo}): ${ev.reason}`);
    return { sold: false, reason: ev.reason };
  }

  try {
    await ensureAllowances(ev.amountAxisWei);

    // Sell AXIS(currency1) → ETH(currency0): zeroForOne = false.
    const swapParam = coder.encode(
      [`tuple(${POOLKEY_T} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`],
      [[POOL_KEY, false, ev.amountAxisWei, ev.minOutWei, "0x"]],
    );
    const settleParam = coder.encode(["address", "uint256"], [AXIS, ev.amountAxisWei]);
    const takeParam = coder.encode(["address", "uint256"], [ETH, ev.minOutWei]);
    const input = coder.encode(
      ["bytes", "bytes[]"],
      [ACTIONS_EXACT_IN, [swapParam, settleParam, takeParam]],
    );
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

    const router = new ethers.Contract(UNIVERSAL_ROUTER, ROUTER_ABI, signer);
    const tx = await router.execute(CMD_V4_SWAP, [input], deadline);
    const receipt = await tx.wait();
    // eslint-disable-next-line no-console
    console.log(`[autosell] sold ${ev.axis} AXIS → ~${ev.quotedEth} ETH (${memo}) tx ${receipt.hash}`);
    return { sold: true, tx: receipt.hash, axis: ev.axis, eth: ev.quotedEth, impactBps: ev.impactBps };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[autosell] swap failed (${memo}): ${e.shortMessage || e.message}`);
    return { sold: false, reason: `swap failed: ${e.shortMessage || e.message}` };
  }
}

module.exports = { coverCost, topUpValidator, evaluate, quoteSell, spotEthPerAxis, enabled };
