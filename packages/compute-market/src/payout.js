"use strict";

const { ethers } = require("ethers");
const config = require("./config");
const { provider } = require("./payments");

const ERC20_ABI = ["function transfer(address to, uint256 amount) returns (bool)"];

// Treasury signer (holds buyer payments, pays out miners). NonceManager keeps
// concurrent payouts from colliding on nonces. Exported so the cost-coverage
// auto-sell shares the SAME NonceManager and can't race the payout nonces.
let signer = null;
let token = null;
if (config.treasuryKey) {
  const wallet = new ethers.Wallet(config.treasuryKey, provider);
  signer = new ethers.NonceManager(wallet);
  token = new ethers.Contract(config.axisToken, ERC20_ABI, signer);
}

/** True if the marketplace can pay miners (treasury key configured). */
function canPayout() {
  return !!token;
}

/** Sends `axisWei` of AXIS from the treasury to the miner. Returns the tx hash. */
async function payMiner(minerAddress, axisWei) {
  if (!token) throw new Error("treasury not configured");
  const tx = await token.transfer(minerAddress, axisWei);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Permanently removes `axisWei` from circulating supply by sending it to the
 * burn address — a plain ERC-20 transfer to an unspendable account, so it needs
 * no changes to the (renounced) AXIS contract. Returns the tx hash.
 */
async function burnAxis(axisWei) {
  if (!token) throw new Error("treasury not configured");
  const tx = await token.transfer(config.burnAddress, axisWei);
  const receipt = await tx.wait();
  return receipt.hash;
}

module.exports = { payMiner, burnAxis, canPayout, signer, provider };
