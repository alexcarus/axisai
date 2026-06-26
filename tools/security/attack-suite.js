"use strict";

/**
 * AXIS AI — adversarial attack/regression suite.
 *
 * Probes auth bypass, signature forgery, replay/double-mint, cooldown griefing,
 * cross-channel rate limiting, reward inflation, marketplace forgery, SQL
 * injection and stale read-auth — against the live stack.
 *
 * Run the stack first (./start.sh), then:
 *   npm install                       # once, links @axis/shared + ethers
 *   node tools/security/attack-suite.js
 *
 * Configurable via env (defaults shown):
 *   GATEWAY_URL=http://127.0.0.1:3000
 *   ENGINE_URL=http://127.0.0.1:4000
 *   MARKETPLACE_URL=http://127.0.0.1:5000
 *   RPC_URL=http://127.0.0.1:8545
 *   BOT_SIGNER_SECRET=axis-dev-signer-secret-change-me
 */
const { ethers } = require("ethers");
const wlib = require("@axis/shared");

const ENGINE = process.env.ENGINE_URL || "http://127.0.0.1:4000";
const GW = process.env.GATEWAY_URL || "http://127.0.0.1:3000";
const MKT = process.env.MARKETPLACE_URL || "http://127.0.0.1:5000";
const SECRET = process.env.BOT_SIGNER_SECRET || "axis-dev-signer-secret-change-me";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "http://127.0.0.1:8545");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  let b; try { b = await r.json(); } catch { b = {}; }
  return { status: r.status, body: b };
}
async function get(url, headers = {}) {
  const r = await fetch(url, { headers });
  let b; try { b = await r.json(); } catch { b = {}; }
  return { status: r.status, body: b };
}
let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? "[SECURE]" : "[VULN]  "} ${m}`); c ? pass++ : fail++; };
async function buildBody(wallet, workType, outputObj, channel = "telegram") {
  const blockHeight = await provider.getBlockNumber().catch(() => 0);
  return wlib.buildSubmission(wallet, workType, JSON.stringify(outputObj), { blockHeight, channel });
}
async function waitStatus(jobId) {
  let s;
  for (let i = 0; i < 25; i++) { await sleep(700); s = await get(`${ENGINE}/status/${jobId}`); if (["approved", "rejected", "error"].includes(s.body.status)) return s.body; }
  return s && s.body;
}
const GOOD = { text: "the inference output is coherent relevant accurate and well structured" };

(async () => {
  console.log("\n================ AXIS ATTACK SUITE ================\n");

  console.log("[1] Gateway signature forgery");
  {
    const victim = wlib.deriveWallet(SECRET, "telegram", "victim");
    const body = await buildBody(victim, "inference_text", GOOD);
    body.signature = "0x" + "11".repeat(65);
    ok((await post(`${GW}/gateway/submit`, body, { "x-channel": "telegram" })).status === 401, "forged signature rejected at gateway");
    const b2 = { ...body }; delete b2.signature;
    ok((await post(`${GW}/gateway/submit`, b2, { "x-channel": "telegram" })).status === 401, "missing signature rejected at gateway");
  }

  console.log("[2] Gateway wallet-mismatch (sign as attacker, claim victim)");
  {
    const attacker = wlib.deriveWallet(SECRET, "telegram", "attacker2");
    const victim = wlib.deriveWallet(SECRET, "telegram", "victim2");
    const body = await buildBody(attacker, "inference_text", GOOD);
    body.wallet_address = victim.address;
    ok((await post(`${GW}/gateway/submit`, body, { "x-channel": "telegram" })).status === 401, "wallet-mismatch rejected at gateway");
  }

  console.log("[3] Cross-channel rate limit (telegram -> whatsapp, same wallet)");
  {
    const w = wlib.deriveWallet(SECRET, "x", "xchannel-" + Date.now());
    const r1 = await post(`${GW}/gateway/submit`, await buildBody(w, "inference_text", GOOD, "telegram"), { "x-channel": "telegram" });
    const r2 = await post(`${GW}/gateway/submit`, await buildBody(w, "inference_text", { text: GOOD.text + " two" }, "whatsapp"), { "x-channel": "whatsapp" });
    ok(r1.status === 202 && r2.status === 429, `2nd channel blocked by wallet cooldown (tg=${r1.status}, wa=${r2.status})`);
  }

  console.log("[4] Gateway nonce/replay (identical signed body twice)");
  {
    const w = wlib.deriveWallet(SECRET, "telegram", "nonce-" + Date.now());
    const b = await buildBody(w, "inference_text", GOOD);
    const [ra, rb] = await Promise.all([post(`${GW}/gateway/submit`, b, { "x-channel": "telegram" }), post(`${GW}/gateway/submit`, b, { "x-channel": "telegram" })]);
    ok([ra.status, rb.status].filter((s) => s === 202).length === 1, `exactly one of two identical bodies accepted (${ra.status},${rb.status})`);
  }

  console.log("[5] DIRECT ENGINE replay -> double mint");
  {
    const w = wlib.deriveWallet(SECRET, "engine", "replay-" + Date.now());
    const b = await buildBody(w, "inference_text", GOOD);
    const r1 = await post(`${ENGINE}/submit`, b);
    const s1 = r1.body.job_id ? await waitStatus(r1.body.job_id) : r1.body;
    await sleep(500);
    const r2 = await post(`${ENGINE}/submit`, b);
    const s2 = r2.body.job_id ? await waitStatus(r2.body.job_id) : r2.body;
    const m = await get(`${ENGINE}/miner/${w.address}`);
    ok(!(s2 && s2.status === "approved"), `replay NOT re-minted (1st=${s1 && s1.status}, 2nd=${s2 && s2.status}, total=${m.body && m.body.total_axis_earned})`);
  }

  console.log("[6] DIRECT ENGINE cooldown griefing");
  {
    const victim = wlib.deriveWallet(SECRET, "engine", "grief-victim-" + Date.now());
    const attacker = wlib.deriveWallet(SECRET, "engine", "grief-attacker");
    const b = await buildBody(attacker, "inference_text", GOOD);
    b.wallet_address = victim.address;
    const r = await post(`${ENGINE}/submit`, b);
    if (r.body.job_id) await waitStatus(r.body.job_id);
    await sleep(400);
    const m = await get(`${ENGINE}/miner/${victim.address}`);
    ok(!(m.body && m.body.on_cooldown), `victim NOT cooled down by attacker's invalid submission`);
  }

  console.log("[7] Reward inflation via huge output_data");
  {
    const w = wlib.deriveWallet(SECRET, "engine", "inflate-" + Date.now());
    const b = await buildBody(w, "inference_text", { text: "the coherent relevant accurate output ".repeat(50000) });
    const r = await post(`${ENGINE}/submit`, b);
    const s = r.body.job_id ? await waitStatus(r.body.job_id) : r.body;
    const wl = s && s.workload != null ? Number(s.workload) : null;
    ok(wl === null || wl <= 1000, `workload capped (W=${wl})`);
  }

  console.log("[8] Marketplace publish signature forgery");
  {
    const owner = wlib.deriveWallet(SECRET, "mkt", "owner").address;
    ok((await post(`${MKT}/models/publish`, { name: "m1", work_type: "inference_text", price_in_axis: "1", owner_wallet: owner, signature: "0x" + "22".repeat(65) })).status === 401, "forged publish signature rejected");
  }

  console.log("[9] SQL injection probes");
  {
    ok((await get(`${ENGINE}/miner/${encodeURIComponent("0x' OR '1'='1")}`)).status === 400, "injection in /miner rejected as invalid address");
    const r2 = await get(`${ENGINE}/status/${encodeURIComponent("1');DROP TABLE submissions;--")}`);
    ok(r2.status === 404 || r2.status === 200, "injection in /status handled safely");
    ok((await get(`${ENGINE}/network/stats`)).status === 200, "submissions table intact after injection attempt");
  }

  console.log("[10] Gateway read-auth: stale/forged headers");
  {
    const w = wlib.deriveWallet(SECRET, "telegram", "readauth");
    ok((await get(`${GW}/gateway/network/stats`, { "x-wallet-address": w.address, "x-timestamp": String(Date.now() - 10 * 60 * 1000), "x-signature": "0x" + "33".repeat(65) })).status === 401, "stale/forged read-auth rejected");
  }

  console.log(`\n================ RESULT: ${pass} secure / ${fail} vulnerable ================\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("ATTACK HARNESS ERROR", e); process.exit(1); });
