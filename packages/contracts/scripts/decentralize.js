/* eslint-disable no-console */
// ===========================================================================
// AXIS AI — decentralize / renounce helper.
//
// Drives the EXISTING ValidatorRegistry governance (no contract changes, no
// change to Proof-of-AI-Work): add independent validators, vote, and renounce
// the bootstrap deployer's seat so the protocol ends up with NO owner and a
// decentralized validator federation.
//
// Inputs are env vars (so it works with `hardhat run`). Run from packages/contracts:
//
//   # show the current validator set (read-only)
//   hardhat run scripts/decentralize.js --network <net>
//
//   # add one or more independent validators (a sole bootstrap validator can
//   # add the first one unilaterally; after that, governance needs >66%)
//   DECENTRALIZE_ADD=0xV1,0xV2 hardhat run scripts/decentralize.js --network <net>
//
//   # propose removing (renouncing) a validator — needs a supermajority, so the
//   # OTHER validators must also vote on the printed proposal id
//   DECENTRALIZE_REMOVE=0xDeployer hardhat run scripts/decentralize.js --network <net>
//
//   # another validator casts their vote (act as their key)
//   VALIDATOR_KEY=0x... DECENTRALIZE_VOTE=<id> hardhat run scripts/decentralize.js --network <net>
//
// VALIDATOR_KEY overrides the signer so each validator can act with their own
// key; otherwise the network's default account (DEPLOYER_PRIVATE_KEY) is used.
// ===========================================================================
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Matches the ValidatorRegistry.ProposalType enum.
const ProposalType = { AddValidator: 0, RemoveValidator: 1, SetDifficulty: 2 };

function loadDeployment(network) {
  const p = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`No deployment for network "${network}" at ${p}. Deploy first.`);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function lastProposalId(registry) {
  return ((await registry.proposalCount()) - 1n).toString();
}

async function printState(registry, me) {
  const [addrs, active] = await registry.getValidators();
  const count = await registry.validatorCount();
  const required = await registry.votesRequired();
  console.log("\n=== AXIS validator set ===");
  console.log(`network           : ${hre.network.name}`);
  console.log(`registry          : ${await registry.getAddress()}`);
  console.log(`active validators : ${count}  (governance needs ${required} of ${count}, i.e. >66%)`);
  for (let i = 0; i < addrs.length; i++) {
    if (active[i]) {
      const mine = addrs[i].toLowerCase() === me.toLowerCase() ? "  <- you" : "";
      console.log(`  - ${addrs[i]}${mine}`);
    }
  }
}

async function main() {
  const d = loadDeployment(hre.network.name);

  // Pick the acting signer: an explicit validator key, or the network default.
  let signer;
  if (process.env.VALIDATOR_KEY) {
    signer = new hre.ethers.Wallet(process.env.VALIDATOR_KEY, hre.ethers.provider);
  } else {
    [signer] = await hre.ethers.getSigners();
  }
  const me = await signer.getAddress();

  const registry = await hre.ethers.getContractAt(
    "ValidatorRegistry",
    d.contracts.ValidatorRegistry,
    signer,
  );

  console.log(`Acting as: ${me}`);

  const add = (process.env.DECENTRALIZE_ADD || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const remove = (process.env.DECENTRALIZE_REMOVE || "").trim();
  const voteId = (process.env.DECENTRALIZE_VOTE || "").trim();
  const execId = (process.env.DECENTRALIZE_EXECUTE || "").trim();
  const setDiff = (process.env.DECENTRALIZE_SET_DIFFICULTY || "").trim();

  const wantsAction = add.length || remove || voteId || execId || setDiff;

  if (wantsAction && !(await registry.isValidator(me))) {
    console.log("⚠ You are not a current validator — only validators may propose or vote.");
    await printState(registry, me);
    return;
  }

  // --- Add validators ---------------------------------------------------- //
  for (const v of add) {
    if (!hre.ethers.isAddress(v)) {
      console.log(`skip invalid address: ${v}`);
      continue;
    }
    if (await registry.isValidator(v)) {
      console.log(`already a validator: ${v}`);
      continue;
    }
    console.log(`\nProposing AddValidator(${v})…`);
    await (await registry.createProposal(ProposalType.AddValidator, v, 0)).wait();
    const id = await lastProposalId(registry);
    if (await registry.isValidator(v)) {
      console.log(`  ✓ executed immediately — ${v} is now a validator`);
    } else {
      console.log(`  • proposal ${id} created; needs ${await registry.votesRequired()} votes. Other validators: DECENTRALIZE_VOTE=${id}`);
    }
  }

  // --- Renounce / remove a validator ------------------------------------- //
  if (remove) {
    if (!hre.ethers.isAddress(remove)) throw new Error(`invalid remove address: ${remove}`);
    const count = await registry.validatorCount();
    if (count <= 1n) {
      console.log("\n⚠ Cannot remove the last validator (the contract forbids it). Add at least one independent validator first, then renounce.");
    } else if (!(await registry.isValidator(remove))) {
      console.log(`\n${remove} is not an active validator; nothing to remove.`);
    } else {
      console.log(`\nProposing RemoveValidator(${remove})…`);
      await (await registry.createProposal(ProposalType.RemoveValidator, remove, 0)).wait();
      const id = await lastProposalId(registry);
      if (!(await registry.isValidator(remove))) {
        console.log(`  ✓ executed — ${remove} removed from the validator set`);
      } else {
        console.log(`  • proposal ${id} created; needs ${await registry.votesRequired()} votes. Other validators: DECENTRALIZE_VOTE=${id}`);
      }
    }
  }

  // --- Optional: set the base difficulty (note: the supply ramp is automatic) //
  if (setDiff) {
    const n = BigInt(setDiff);
    console.log(`\nProposing SetDifficulty(${n})… (the >25% supply ramp already adjusts difficulty automatically)`);
    await (await registry.createProposal(ProposalType.SetDifficulty, hre.ethers.ZeroAddress, n)).wait();
    const id = await lastProposalId(registry);
    console.log(`  • proposal ${id} created (auto-executes if you alone meet supermajority)`);
  }

  // --- Vote / execute an existing proposal ------------------------------- //
  if (voteId) {
    console.log(`\nVoting YES on proposal ${voteId}…`);
    await (await registry.vote(BigInt(voteId))).wait();
    console.log("  ✓ vote cast (auto-executes if this crossed the supermajority)");
  }
  if (execId) {
    console.log(`\nExecuting proposal ${execId}…`);
    await (await registry.executeProposal(BigInt(execId))).wait();
    console.log("  ✓ executed");
  }

  if (!wantsAction) {
    console.log("\nNo operation requested — showing state only.");
    console.log("Set DECENTRALIZE_ADD / DECENTRALIZE_REMOVE / DECENTRALIZE_VOTE / DECENTRALIZE_EXECUTE / DECENTRALIZE_SET_DIFFICULTY to act.");
  }

  await printState(registry, me);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
