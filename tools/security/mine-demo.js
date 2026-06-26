"use strict";

/**
 * AXIS AI — end-to-end mining smoke test through the gateway.
 * Signs a submission as a derived mining wallet, posts it to the gateway, polls
 * status, and prints the on-chain reward.
 *
 *   node tools/security/mine-demo.js
 *
 * Env (defaults): GATEWAY_URL, RPC_URL, BOT_SIGNER_SECRET.
 */
const { ethers } = require("ethers");
const { deriveWallet, GatewayClient } = require("@axis/shared");

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "http://127.0.0.1:8545");
const gw = new GatewayClient(process.env.GATEWAY_URL || "http://127.0.0.1:3000", provider);
const SECRET = process.env.BOT_SIGNER_SECRET || "axis-dev-signer-secret-change-me";

(async () => {
  const wallet = deriveWallet(SECRET, "telegram", "mine-demo-" + Date.now());
  console.log("Miner wallet:", wallet.address);

  const output = JSON.stringify({ text: "the inference output is coherent relevant accurate and well structured" });
  const sub = await gw.submit(wallet, "inference_text", output, "telegram");
  console.log("submit:", sub.status, JSON.stringify(sub.body));
  if (!sub.body.job_id) process.exit(1);

  let st;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    st = await gw.status(wallet, sub.body.job_id);
    if (st.body && ["approved", "rejected", "error"].includes(st.body.status)) break;
  }
  console.log("final status:", JSON.stringify(st.body, null, 2));
  const m = await gw.miner(wallet);
  console.log("miner profile:", JSON.stringify(m.body, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
