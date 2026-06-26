const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * AXIS AI protocol contract test suite.
 *
 * Covers: mint cap, epoch transitions, reward formula, supply exhaustion,
 * unauthorized mint rejection, and validator supermajority voting.
 */

const E = (n) => ethers.parseEther(n.toString());

async function deployProtocol(validators) {
  const Registry = await ethers.getContractFactory("ValidatorRegistry");
  const registry = await Registry.deploy(validators);
  await registry.waitForDeployment();

  const Token = await ethers.getContractFactory("AXISToken");
  const token = await Token.deploy(await registry.getAddress());
  await token.waitForDeployment();

  await (await registry.initializeToken(await token.getAddress())).wait();
  return { registry, token };
}

describe("AXISToken", function () {
  let deployer, miner, v2, v3, outsider;
  let registry, token;

  beforeEach(async function () {
    [deployer, miner, v2, v3, outsider] = await ethers.getSigners();
    ({ registry, token } = await deployProtocol([deployer.address]));
  });

  describe("Metadata & invariants", function () {
    it("has correct name, symbol and cap", async function () {
      expect(await token.name()).to.equal("AXIS AI");
      expect(await token.symbol()).to.equal("AXIS");
      expect(await token.MAX_SUPPLY()).to.equal(E(84_000_000));
      expect(await token.GENESIS_SUPPLY()).to.equal(E(21_000_000));
      expect(await token.totalMinted()).to.equal(0n);
      expect(await token.difficulty()).to.equal(1n);
      expect(await token.currentEpoch()).to.equal(1n);
      expect(await token.currentBaseReward()).to.equal(E(200));
    });

    it("rejects a zero registry at construction", async function () {
      const Token = await ethers.getContractFactory("AXISToken");
      await expect(Token.deploy(ethers.ZeroAddress)).to.be.revertedWith(
        "AXIS: registry is zero"
      );
    });
  });

  describe("Unauthorized mint rejection", function () {
    it("reverts when a non-registry account calls mint", async function () {
      await expect(token.connect(outsider).mint(miner.address, 1, 100)).to.be.revertedWith(
        "AXIS: caller is not registry"
      );
    });

    it("reverts when the deployer (an EOA) calls mint directly", async function () {
      await expect(token.connect(deployer).mint(miner.address, 1, 100)).to.be.revertedWith(
        "AXIS: caller is not registry"
      );
    });

    it("reverts when a non-validator submits work via the registry", async function () {
      await expect(
        registry.connect(outsider).submitWork(miner.address, 1, 100)
      ).to.be.revertedWith("Registry: caller not validator");
    });
  });

  describe("Reward formula  (reward = base x W x Q / (D x 100))", function () {
    it("mints exactly the epoch reward for W=1, Q=100, D=1", async function () {
      await registry.submitWork(miner.address, 1, 100);
      expect(await token.balanceOf(miner.address)).to.equal(E(200));
      expect(await token.totalMinted()).to.equal(E(200));
    });

    it("halves the reward at Q=50", async function () {
      await registry.submitWork(miner.address, 1, 50);
      expect(await token.balanceOf(miner.address)).to.equal(E(100));
    });

    it("scales linearly with workload W", async function () {
      await registry.submitWork(miner.address, 3, 100);
      expect(await token.balanceOf(miner.address)).to.equal(E(600));
    });

    it("divides by difficulty D", async function () {
      // Single-validator network: createProposal auto-executes.
      await registry.createProposal(2 /* SetDifficulty */, ethers.ZeroAddress, 4);
      expect(await token.difficulty()).to.equal(4n);
      await registry.submitWork(miner.address, 1, 100); // 200 * 1 * 100 / (4*100) = 50
      expect(await token.balanceOf(miner.address)).to.equal(E(50));
    });

    it("rejects invalid quality scores", async function () {
      await expect(registry.submitWork(miner.address, 1, 0)).to.be.revertedWith(
        "AXIS: quality out of range"
      );
      await expect(registry.submitWork(miner.address, 1, 101)).to.be.revertedWith(
        "AXIS: quality out of range"
      );
    });

    it("rejects zero workload", async function () {
      await expect(registry.submitWork(miner.address, 0, 100)).to.be.revertedWith(
        "AXIS: workload is zero"
      );
    });

    it("previewReward matches the minted amount", async function () {
      const preview = await token.previewReward(2, 75); // 200*2*75/100 = 300
      expect(preview).to.equal(E(300));
    });
  });

  describe("Post-Genesis difficulty ramp (harder to mine past 25%)", function () {
    // Mines exactly through the four Genesis epochs to land on 21,000,000 AXIS
    // (the 25% / Genesis boundary) while the multiplier is still 1.0x.
    async function mineThroughGenesis() {
      await registry.submitWork(miner.address, 26_250, 100); // -> 5.25M
      await registry.submitWork(miner.address, 52_500, 100); // -> 10.5M
      await registry.submitWork(miner.address, 105_000, 100); // -> 15.75M
      await registry.submitWork(miner.address, 210_000, 100); // -> 21M (Genesis end)
    }

    it("keeps difficulty at 1.0x throughout the Genesis Phase", async function () {
      expect(await token.supplyDifficultyMultiplier()).to.equal(10000n);
      expect(await token.effectiveDifficulty()).to.equal(1n);
      await registry.submitWork(miner.address, 26_250, 100); // 5.25M, still genesis
      expect(await token.supplyDifficultyMultiplier()).to.equal(10000n);
      expect(await token.effectiveDifficulty()).to.equal(1n);
    });

    it("ramps difficulty up once past 25% of supply", async function () {
      await mineThroughGenesis();
      expect(await token.totalMinted()).to.equal(E(21_000_000));
      expect(await token.supplyDifficultyMultiplier()).to.equal(10000n);

      // One Standard-phase mint that lands exactly on 42M while still at 1.0x.
      // 12.5 * 1,680,000 = 21,000,000 -> totalMinted 42M (50% of supply).
      await registry.submitWork(miner.address, 1_680_000, 100);
      expect(await token.totalMinted()).to.equal(E(42_000_000));

      const mult = await token.supplyDifficultyMultiplier();
      expect(mult).to.be.greaterThan(10000n); // strictly harder than Genesis
      expect(await token.effectiveDifficulty()).to.equal(mult / 10000n);
    });

    it("reduces the reward by the supply multiplier past 25%", async function () {
      await mineThroughGenesis();
      await registry.submitWork(miner.address, 1_680_000, 100); // -> 42M
      const mult = await token.supplyDifficultyMultiplier();

      const base = E("12.5"); // Standard-phase base reward
      const preview = await token.previewReward(1, 100);
      expect(preview).to.be.lessThan(base); // harder than the naive W×Q÷D reward
      expect(preview).to.equal((base * 10000n) / mult);
    });

    it("reaches the 8.0x difficulty cap when fully mined", async function () {
      await registry.submitWork(miner.address, 10_000_000, 100); // clamps to the cap
      expect(await token.totalMinted()).to.equal(E(84_000_000));
      expect(await token.supplyDifficultyMultiplier()).to.equal(80000n); // 8.0x
      expect(await token.effectiveDifficulty()).to.equal(8n);
    });
  });

  describe("Epoch transitions (automatic, totalMinted-driven)", function () {
    it("transitions from epoch 1 to 2 at 5,250,000 AXIS", async function () {
      // 200 * 26250 = 5,250,000 -> exactly epoch 1 end.
      await registry.submitWork(miner.address, 26_250, 100);
      expect(await token.totalMinted()).to.equal(E(5_250_000));
      expect(await token.currentEpoch()).to.equal(2n);
      expect(await token.currentBaseReward()).to.equal(E(100));
    });

    it("walks through all four Genesis epochs", async function () {
      await registry.submitWork(miner.address, 26_250, 100); // -> 5.25M, epoch 2
      expect(await token.currentEpoch()).to.equal(2n);
      // epoch 2 base 100: 100 * 52500 = 5.25M -> 10.5M
      await registry.submitWork(miner.address, 52_500, 100);
      expect(await token.totalMinted()).to.equal(E(10_500_000));
      expect(await token.currentEpoch()).to.equal(3n);
      // epoch 3 base 50: 50 * 105000 = 5.25M -> 15.75M
      await registry.submitWork(miner.address, 105_000, 100);
      expect(await token.totalMinted()).to.equal(E(15_750_000));
      expect(await token.currentEpoch()).to.equal(4n);
      // epoch 4 base 25: 25 * 210000 = 5.25M -> 21M (end of Genesis)
      await registry.submitWork(miner.address, 210_000, 100);
      expect(await token.totalMinted()).to.equal(E(21_000_000));
      expect(await token.isGenesisPhase()).to.equal(false);
      expect(await token.currentEpoch()).to.equal(5n); // Standard phase
      expect(await token.currentBaseReward()).to.equal(E("12.5"));
    });

    it("emits an EpochTransition event when crossing a boundary", async function () {
      await expect(registry.submitWork(miner.address, 26_250, 100))
        .to.emit(token, "EpochTransition")
        .withArgs(2n, E(5_250_000), E(100));
    });
  });

  describe("Mint cap & supply exhaustion", function () {
    it("clamps the final mint to the hard cap and disables minting", async function () {
      // base 200 * W 420000 = 84,000,000 == cap exactly.
      await registry.submitWork(miner.address, 420_000, 100);
      expect(await token.totalMinted()).to.equal(E(84_000_000));
      expect(await token.totalSupply()).to.equal(E(84_000_000));
      expect(await token.mintingPermanentlyDisabled()).to.equal(true);
    });

    it("never exceeds the cap even with an oversized workload", async function () {
      // Request far more than the cap; mint must clamp to remaining supply.
      await registry.submitWork(miner.address, 10_000_000, 100);
      expect(await token.totalMinted()).to.equal(E(84_000_000));
      expect(await token.balanceOf(miner.address)).to.equal(E(84_000_000));
    });

    it("permanently rejects minting after exhaustion", async function () {
      await registry.submitWork(miner.address, 10_000_000, 100);
      await expect(registry.submitWork(miner.address, 1, 100)).to.be.revertedWith(
        "AXIS: minting disabled"
      );
    });
  });
});

describe("ValidatorRegistry — supermajority governance", function () {
  let deployer, v2, v3, v4, miner, outsider;
  let registry, token;

  beforeEach(async function () {
    [deployer, v2, v3, v4, miner, outsider] = await ethers.getSigners();
    ({ registry, token } = await deployProtocol([
      deployer.address,
      v2.address,
      v3.address,
    ]));
  });

  it("starts with the correct validator set and threshold", async function () {
    expect(await registry.validatorCount()).to.equal(3n);
    expect(await registry.votesRequired()).to.equal(2n); // >66% of 3 => 2
    expect(await registry.isValidator(deployer.address)).to.equal(true);
    expect(await registry.isValidator(outsider.address)).to.equal(false);
  });

  it("requires supermajority to add a validator", async function () {
    // Proposal type 0 = AddValidator.
    await registry.connect(deployer).createProposal(0, v4.address, 0);
    // 1/3 votes => not executed yet.
    expect(await registry.isValidator(v4.address)).to.equal(false);

    await registry.connect(v2).vote(0); // 2/3 = 66.6% > 66% => executes
    expect(await registry.isValidator(v4.address)).to.equal(true);
    expect(await registry.validatorCount()).to.equal(4n);
  });

  it("requires supermajority to remove a validator", async function () {
    await registry.connect(deployer).createProposal(1 /* Remove */, v3.address, 0);
    expect(await registry.isValidator(v3.address)).to.equal(true); // 1/3 only
    await registry.connect(v2).vote(0); // 2/3 => executes
    expect(await registry.isValidator(v3.address)).to.equal(false);
    expect(await registry.validatorCount()).to.equal(2n);
  });

  it("blocks double voting", async function () {
    await registry.connect(deployer).createProposal(0, v4.address, 0);
    await expect(registry.connect(deployer).vote(0)).to.be.revertedWith(
      "Registry: already voted"
    );
  });

  it("blocks non-validators from voting or proposing", async function () {
    await registry.connect(deployer).createProposal(0, v4.address, 0);
    await expect(registry.connect(outsider).vote(0)).to.be.revertedWith(
      "Registry: caller not validator"
    );
    await expect(
      registry.connect(outsider).createProposal(0, v4.address, 0)
    ).to.be.revertedWith("Registry: caller not validator");
  });

  it("changes difficulty only via supermajority vote", async function () {
    await registry.connect(deployer).createProposal(2 /* SetDifficulty */, ethers.ZeroAddress, 7);
    expect(await token.difficulty()).to.equal(1n); // not yet
    await registry.connect(v3).vote(0);
    expect(await token.difficulty()).to.equal(7n);
  });

  it("cannot remove the last validator", async function () {
    const single = await deployProtocol([deployer.address]);
    await expect(
      single.registry.createProposal(1, deployer.address, 0)
    ).to.be.revertedWith("Registry: cannot remove last validator");
  });

  it("emits governance events", async function () {
    await expect(registry.connect(deployer).createProposal(0, v4.address, 0))
      .to.emit(registry, "ProposalCreated")
      .and.to.emit(registry, "VoteCast");
    await expect(registry.connect(v2).vote(0))
      .to.emit(registry, "ValidatorAdded")
      .and.to.emit(registry, "ProposalExecuted");
  });

  it("allows any single validator to submit work (normal operation)", async function () {
    await registry.connect(v2).submitWork(miner.address, 1, 100);
    expect(await token.balanceOf(miner.address)).to.equal(E(200));
  });
});
