"use strict";

const { ethers } = require("ethers");
const { createUserStore, GatewayClient, deriveWallet } = require("@axis/shared");
const config = require("./config");

/**
 * Shared runtime context for the Telegram bot: chain provider, gateway client
 * and the shared user store. Also derives each user's deterministic mining
 * wallet.
 */
const provider = new ethers.JsonRpcProvider(config.rpcUrl);
const gateway = new GatewayClient(config.gatewayUrl, provider);
const userStore = createUserStore(config.databaseUrl);

const CHANNEL = "telegram";

/** Derives the mining wallet for a Telegram user id. */
function walletFor(userId) {
  return deriveWallet(config.signerSecret, CHANNEL, userId);
}

/** Returns true if the user has completed /register. */
async function isRegistered(userId) {
  const w = walletFor(userId);
  const stored = await userStore.getUserWallet(CHANNEL, userId);
  return stored && stored.toLowerCase() === w.address.toLowerCase();
}

module.exports = { provider, gateway, userStore, walletFor, isRegistered, CHANNEL };
