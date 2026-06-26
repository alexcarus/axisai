"use strict";
/**
 * AXIS AI — mint / contract-layer attack probes (+ engine firewall check).
 *
 * Complements attack-suite.js (which targets the HTTP gateway) by attacking the
 * on-chain minting surface directly: unauthorized mint, unauthorized work
 * submission, unauthorized difficulty changes, governance abuse, and input
 * bounds. Every probe uses staticCall (eth_call) so it simulates the attack
 * WITHOUT changing state or spending gas.
 *
 * Run with the stack up:
 *   node tools/security/mint-attack.js
 * Env (defaults shown): RPC_URL, ENGINE_URL, DEPLOY_NETWORK=localhost,
 *   VALIDATOR_PRIVATE_KEY (to test the legitimate validator path's input bounds).
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const ENGINE = process.env.ENGINE_URL || "http://127.0.0.1:4000";
const provider = new ethers.JsonRpcProvider(RPC);

function deployment() {
  const net = process.env.DEPLOY_NETWORK || "localhost";
  const p = path.join(__dirname, "..", "..", "packages", "contracts", "deployments", `${net}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

let pass = 0;
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? "[SECURE]" : "[VULN]  "} ${m}`);
  c ? pass++ : fail++;
};

const TOKEN_ABI = [
  "function mint(address,uint256,uint256) returns (uint256)",
  "function setDifficulty(uint256)",
  "function totalMinted() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function validatorRegistry() view returns (address)",
];
const REG_ABI = [
  "function submitWork(address,uint256,uint256) returns (uint256)",
  "function createProposal(uint8,address,uint256) returns (uint256)",
  "function isValidator(address) view returns (bool)",
];

async function reverts(promise) {
  try {
    await promise;
    return false;
  } catch {
    return true;
  }
}

(async () => {
  console.log("\n========== AXIS MINT / CONTRACT ATTACK PROBES ==========\n");
  const d = deployment();
  const tokenAddr = d.contracts.AXISToken;
  const regAddr = d.contracts.ValidatorRegistry;

  const attacker = ethers.Wallet.createRandom().connect(provider);
  const token = new ethers.Contract(tokenAddr, TOKEN_ABI, attacker);
  const reg = new ethers.Contract(regAddr, REG_ABI, attacker);

  console.log(`token   : ${tokenAddr}`);
  console.log(`registry: ${regAddr}`);
  console.log(`attacker: ${attacker.address} (random, non-validator)\n`);

  console.log("[A] Unauthorized direct mint (attacker -> token.mint)");
  ok(
    await reverts(token.mint.staticCall(attacker.address, 1_000_000n, 100n)),
    "token.mint reverts for a non-registry caller",
  );

  console.log("[B] Unauthorized work submission (non-validator -> registry.submitWork)");
  ok(!(await reg.isValidator(attacker.address)), "attacker is not a validator");
  ok(
    await reverts(reg.submitWork.staticCall(attacker.address, 1_000_000n, 100n)),
    "registry.submitWork reverts for a non-validator",
  );

  console.log("[C] Unauthorized difficulty change (attacker -> token.setDifficulty)");
  ok(
    await reverts(token.setDifficulty.staticCall(1n)),
    "token.setDifficulty reverts for a non-registry caller",
  );

  console.log("[D] Unauthorized governance (non-validator -> registry.createProposal)");
  ok(
    await reverts(reg.createProposal.staticCall(0, attacker.address, 0)),
    "registry.createProposal reverts for a non-validator",
  );

  console.log("[E] Input-bound enforcement on the legitimate validator path");
  const validatorKey =
    process.env.VALIDATOR_PRIVATE_KEY ||
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const validator = new ethers.Wallet(validatorKey, provider);
  const regV = new ethers.Contract(regAddr, REG_ABI, validator);
  const isVal = await regV.isValidator(validator.address);
  ok(isVal, "validator key is a registered validator");
  if (isVal) {
    ok(
      await reverts(regV.submitWork.staticCall(attacker.address, 1n, 101n)),
      "submitWork(quality=101) reverts — quality bound enforced",
    );
    ok(
      await reverts(regV.submitWork.staticCall(attacker.address, 0n, 100n)),
      "submitWork(workload=0) reverts — zero-work rejected",
    );
    ok(
      await reverts(regV.submitWork.staticCall(ethers.ZeroAddress, 1n, 100n)),
      "submitWork(to=0x0) reverts — zero-address rejected",
    );
  }

  console.log("[F] Engine firewall (direct engine access without the internal key)");
  const status = await fetch(`${ENGINE}/network/stats`)
    .then((x) => x.status)
    .catch(() => 0);
  ok(status === 401 || status === 403, `direct engine call rejected without internal key (status ${status})`);

  console.log(`\n========== ${pass} secure / ${fail} vulnerable ==========`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
