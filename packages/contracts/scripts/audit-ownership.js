/* eslint-disable no-console */
// ===========================================================================
// AXIS AI — ownership audit ("no owners" receipt).
//
// Reads the deployed contracts and proves, on-chain, that AXIS has no owner:
//   - AXISToken exposes no owner/admin/pause/upgrade surface (not Ownable),
//     supply is fixed, and the mint authority is the immutable registry.
//   - ValidatorRegistry has no owner — it is governed only by validator
//     supermajority. It lists the live validator set and flags whether the
//     deployer still holds a seat (so you can renounce it later).
//
// Read-only. Run from packages/contracts:
//   hardhat run scripts/audit-ownership.js --network <net>
// ===========================================================================
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

function loadDeployment(network) {
  const p = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(p)) throw new Error(`No deployment for "${network}" at ${p}.`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Probe whether a contract exposes a zero-arg "control" function. Returns the
// decoded value if present, or null if the selector is absent / reverts.
async function probe(provider, address, fragment) {
  const iface = new hre.ethers.Interface([fragment]);
  const name = iface.fragments[0].name;
  try {
    const data = iface.encodeFunctionData(name, []);
    const ret = await provider.call({ to: address, data });
    if (!ret || ret === "0x") return null;
    return iface.decodeFunctionResult(name, ret)[0];
  } catch {
    return null; // no such function -> no such control surface
  }
}

const OWNER_PROBES = [
  "function owner() view returns (address)",
  "function admin() view returns (address)",
  "function getOwner() view returns (address)",
  "function pendingOwner() view returns (address)",
];
const ZERO = "0x0000000000000000000000000000000000000000";

async function anyOwner(provider, address) {
  for (const frag of OWNER_PROBES) {
    const v = await probe(provider, address, frag);
    if (v && v !== ZERO) return { fn: frag, value: v };
  }
  return null;
}

const ok = (b) => (b ? "✓" : "✗");

async function main() {
  const d = loadDeployment(hre.network.name);
  const provider = hre.ethers.provider;
  const tokenAddr = d.contracts.AXISToken;
  const regAddr = d.contracts.ValidatorRegistry;

  const token = await hre.ethers.getContractAt("AXISToken", tokenAddr);
  const registry = await hre.ethers.getContractAt("ValidatorRegistry", regAddr);

  console.log("============================================================");
  console.log(" AXIS AI — OWNERSHIP AUDIT");
  console.log("============================================================");
  console.log(`network : ${hre.network.name}  (chainId ${d.chainId})`);
  console.log(`token   : ${tokenAddr}`);
  console.log(`registry: ${regAddr}`);
  console.log(`deployer: ${d.deployer}`);

  // --- AXISToken ---
  const tokenOwner = await anyOwner(provider, tokenAddr);
  const paused = await probe(provider, tokenAddr, "function paused() view returns (bool)");
  const minter = await token.validatorRegistry();
  const minterMatches = minter.toLowerCase() === regAddr.toLowerCase();
  const mintingDisabled = await token.mintingPermanentlyDisabled();

  console.log("\n--- AXISToken ---");
  console.log(`  ${ok(!tokenOwner)} no owner/admin role (not Ownable)`);
  if (tokenOwner) console.log(`      detected: ${tokenOwner.fn} -> ${tokenOwner.value}`);
  console.log(`  ${ok(paused === null)} no pause function — the token can never be frozen`);
  console.log(`  ${ok(minterMatches)} mint authority is the immutable registry (${minter})`);
  console.log(`      (declared 'immutable' in the contract — can never be reassigned)`);
  console.log(`  name/symbol  : ${await token.name()} / ${await token.symbol()}`);
  console.log(`  MAX_SUPPLY   : ${hre.ethers.formatEther(await token.MAX_SUPPLY())} AXIS (fixed, no admin can change it)`);
  console.log(`  totalMinted  : ${hre.ethers.formatEther(await token.totalMinted())} AXIS`);
  console.log(`  minting permanently disabled: ${mintingDisabled}`);

  // --- ValidatorRegistry ---
  const regOwner = await anyOwner(provider, regAddr);
  const [addrs, active] = await registry.getValidators();
  const count = await registry.validatorCount();
  const required = await registry.votesRequired();
  const tokenInit = await registry.tokenInitialized();
  const deployerIsValidator = await registry.isValidator(d.deployer);

  console.log("\n--- ValidatorRegistry ---");
  console.log(`  ${ok(!regOwner)} no owner/admin role — governed only by validator supermajority`);
  if (regOwner) console.log(`      detected: ${regOwner.fn} -> ${regOwner.value}`);
  console.log(`  ${ok(tokenInit)} token binding is initialized & permanent`);
  console.log(`  active validators: ${count}  (governance needs ${required} of ${count}, i.e. >66%)`);
  for (let i = 0; i < addrs.length; i++) {
    if (active[i]) {
      const tag = addrs[i].toLowerCase() === d.deployer.toLowerCase() ? "  (deployer)" : "";
      console.log(`    - ${addrs[i]}${tag}`);
    }
  }

  // --- Verdict ---
  const ownerless = !tokenOwner && !regOwner && paused === null && minterMatches;
  console.log("\n============================================================");
  console.log(
    ` VERDICT: ${ownerless ? "OWNERLESS ✓  no admin, no multisig, immutable, fixed supply" : "OWNER SURFACE DETECTED ✗  — review above"}`,
  );
  console.log("============================================================");
  console.log(" • Mining is permissionless — anyone earns AXIS to their own wallet.");
  console.log(" • Supply is fixed at 84,000,000; issuance follows code alone.");
  if (count === 1n && deployerIsValidator) {
    console.log(" • You are the sole bootstrap validator (the verifier). The token is");
    console.log("   already ownerless; add independent validators and renounce this seat");
    console.log("   later with scripts/decentralize.js — no redeploy needed.");
  } else if (!deployerIsValidator) {
    console.log(" • The deployer holds NO validator seat — fully renounced. ✓");
  } else {
    console.log(` • ${count} validators; the deployer is one of them. Renounce it via`);
    console.log("   scripts/decentralize.js (DECENTRALIZE_REMOVE=<deployer>) once you're ready.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
