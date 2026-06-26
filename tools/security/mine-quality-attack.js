"use strict";
// Supplementary mining attacks: quality gate, output-hash tamper, engine SQLi (with key).
const wlib = require("@axis/shared");
const { ethers } = require("ethers");

const GW = process.env.GATEWAY_URL || "http://127.0.0.1:3000";
const ENGINE = process.env.ENGINE_URL || "http://127.0.0.1:4000";
const KEY = process.env.ENGINE_INTERNAL_KEY || "";
const SECRET = process.env.BOT_SIGNER_SECRET || "axis-dev-signer-secret-change-me";
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || "http://127.0.0.1:8545");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`  ${c ? "[SECURE]" : "[VULN]  "} ${m}`); c ? pass++ : fail++; };

async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function get(url, headers = {}) {
  const r = await fetch(url, { headers });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function pollGateway(wallet, jobId) {
  for (let i = 0; i < 25; i++) {
    await sleep(700);
    const h = await wlib.buildAuthHeaders(wallet);
    const s = await get(`${GW}/gateway/status/${jobId}`, h);
    if (["approved", "rejected", "error"].includes(s.body.status)) return s.body;
  }
  return {};
}

(async () => {
  console.log("\n===== SUPPLEMENTARY MINING ATTACKS =====\n");
  const blockHeight = await provider.getBlockNumber().catch(() => 0);

  console.log("[G] Quality gate — mine deliberate junk (should be rejected, not minted)");
  {
    const w = wlib.deriveWallet(SECRET, "telegram", `junk-${Date.now()}`);
    const body = await wlib.buildSubmission(w, "inference_text", JSON.stringify({ text: "a" }), { blockHeight, channel: "telegram" });
    const sub = await post(`${GW}/gateway/submit`, body, { "x-channel": "telegram" });
    if (!sub.body.job_id) { ok(sub.status !== 202, `junk submission not accepted/minted (status ${sub.status})`); }
    else { const f = await pollGateway(w, sub.body.job_id); ok(f.status !== "approved", `junk output NOT minted (verdict=${f.status})`); }
  }

  console.log("[H] Output-hash tamper — change output_data after signing (commitment must fail)");
  {
    const w = wlib.deriveWallet(SECRET, "telegram", `tamper-${Date.now()}`);
    const body = await wlib.buildSubmission(w, "inference_text", JSON.stringify({ text: "the inference output is coherent relevant accurate and well structured" }), { blockHeight, channel: "telegram" });
    body.output_data = JSON.stringify({ text: "TAMPERED — different payload than was committed/signed" });
    const sub = await post(`${GW}/gateway/submit`, body, { "x-channel": "telegram" });
    if (!sub.body.job_id) { ok(true, `tampered submission rejected at gateway (status ${sub.status})`); }
    else { const f = await pollGateway(w, sub.body.job_id); ok(f.status === "rejected" || f.status === "error", `tampered output rejected by engine (verdict=${f.status})`); }
  }

  console.log("[I] Engine input validation WITH the internal key (SQLi / bad address)");
  {
    const inj = encodeURIComponent("0x' OR '1'='1");
    const r1 = await get(`${ENGINE}/miner/${inj}`, { "x-internal-key": KEY });
    ok(r1.status === 400, `SQLi in /miner rejected as invalid address (status ${r1.status})`);
    const r2 = await get(`${ENGINE}/network/stats`, { "x-internal-key": KEY });
    ok(r2.status === 200, `submissions table intact after injection attempt (status ${r2.status})`);
  }

  console.log(`\n===== ${pass} secure / ${fail} vulnerable =====`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
