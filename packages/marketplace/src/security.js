"use strict";

const { ethers } = require("ethers");
const config = require("./config");
const logger = require("./logger");

// Well-known PUBLIC test keys (Hardhat/Anvil accounts #0/#1). The marketplace
// operator key is validator-authorised — it can mint AXIS — so it must never be
// one of these on a real network.
const KNOWN_TEST_KEYS = new Set([
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
]);

/**
 * Refuses to start with an unsafe on-chain settlement configuration. On-chain
 * settlement uses a validator-authorised operator key that can mint AXIS, so in
 * production we require a private, non-test operator key AND a valid operator
 * EOA payout wallet before that path is allowed to run.
 *
 * @param {object} [cfg=config] Injectable for tests.
 * @param {object} [log=logger] Injectable for tests.
 */
function assertProductionSecurity(cfg = config, log = logger) {
  if (cfg.env !== "production" || !cfg.chain.onchain) return;

  const opKey = (cfg.chain.operatorPrivateKey || "").toLowerCase();
  if (!opKey) {
    throw new Error(
      "Refusing to start: ESCROW_ONCHAIN=true but MARKETPLACE_PRIVATE_KEY is not set.",
    );
  }
  if (KNOWN_TEST_KEYS.has(opKey)) {
    throw new Error(
      "Refusing to start in production: MARKETPLACE_PRIVATE_KEY is a well-known PUBLIC " +
        "test key — anyone could mint AXIS with it. Set a private production operator key.",
    );
  }
  if (!ethers.isAddress(cfg.market.minerWallet)) {
    throw new Error(
      "Refusing to start: ESCROW_ONCHAIN=true but MARKET_MINER_WALLET is not a valid " +
        "address. On-chain miner-fee settlement releases only to this operator EOA.",
    );
  }
  if (
    cfg.chain.registryAddress &&
    cfg.market.minerWallet.toLowerCase() === cfg.chain.registryAddress.toLowerCase()
  ) {
    log.warn(
      "MARKET_MINER_WALLET equals the ValidatorRegistry contract address — set it to a " +
        "spendable operator EOA, or on-chain miner-fee releases will be stuck in a contract.",
    );
  }
}

module.exports = { assertProductionSecurity, KNOWN_TEST_KEYS };
