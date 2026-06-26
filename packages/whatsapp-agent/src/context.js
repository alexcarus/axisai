"use strict";

const { ethers } = require("ethers");
const { createUserStore, GatewayClient, deriveWallet } = require("@axis/shared");
const config = require("./config");

const provider = new ethers.JsonRpcProvider(config.rpcUrl);
const gateway = new GatewayClient(config.gatewayUrl, provider);
const userStore = createUserStore(config.databaseUrl);

const CHANNEL = "whatsapp";

function walletFor(waId) {
  return deriveWallet(config.signerSecret, CHANNEL, waId);
}

async function isRegistered(waId) {
  const w = walletFor(waId);
  const stored = await userStore.getUserWallet(CHANNEL, waId);
  return stored && stored.toLowerCase() === w.address.toLowerCase();
}

module.exports = { provider, gateway, userStore, walletFor, isRegistered, CHANNEL };
