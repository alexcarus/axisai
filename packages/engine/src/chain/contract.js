"use strict";

const { ethers } = require("ethers");
const config = require("../config");
const logger = require("../logger");

/**
 * Retries a transient chain read. Public RPCs (e.g. mainnet.base.org) sporadically
 * drop eth_calls and return "missing revert data" under load; a short backoff
 * almost always recovers. Use ONLY for idempotent reads, never for tx sends.
 */
async function withRetry(fn, attempts = 5, baseDelayMs = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * Minimal ABIs for the engine's interaction surface with the AXIS contracts.
 */
const TOKEN_ABI = [
  "function difficulty() view returns (uint256)",
  "function effectiveDifficulty() view returns (uint256)",
  "function supplyDifficultyMultiplier() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function currentEpoch() view returns (uint256)",
  "function currentBaseReward() view returns (uint256)",
  "function previewReward(uint256 workload, uint256 quality) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function isGenesisPhase() view returns (bool)",
];

const REGISTRY_ABI = [
  "function submitWork(address miner, uint256 workload, uint256 quality) returns (uint256)",
  "function isValidator(address) view returns (bool)",
  "event WorkSubmitted(address indexed validator, address indexed miner, uint256 workload, uint256 quality, uint256 mintedAmount)",
];

/**
 * Chain client wrapping the read/write surface used by the verification engine.
 */
class ChainClient {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.chain.rpcUrl);
    this.token = config.chain.tokenAddress
      ? new ethers.Contract(config.chain.tokenAddress, TOKEN_ABI, this.provider)
      : null;

    if (config.chain.validatorPrivateKey) {
      this.signer = new ethers.Wallet(config.chain.validatorPrivateKey, this.provider);
      this.registry = config.chain.registryAddress
        ? new ethers.Contract(config.chain.registryAddress, REGISTRY_ABI, this.signer)
        : null;
    } else {
      this.signer = null;
      this.registry = config.chain.registryAddress
        ? new ethers.Contract(config.chain.registryAddress, REGISTRY_ABI, this.provider)
        : null;
    }
  }

  _assertToken() {
    if (!this.token) throw new Error("AXIS_TOKEN_ADDRESS not configured");
  }

  /** Fetch the current difficulty factor `D` from the token contract. */
  async getDifficulty() {
    this._assertToken();
    return BigInt(await this.token.difficulty());
  }

  /** Fetch totalMinted, current epoch, base reward and supply cap together. */
  async getNetworkState() {
    this._assertToken();
    const [baseDifficulty, totalMinted, maxSupply, epoch, baseReward] = await withRetry(() =>
      Promise.all([
        this.token.difficulty(),
        this.token.totalMinted(),
        this.token.MAX_SUPPLY(),
        this.token.currentEpoch(),
        this.token.currentBaseReward(),
      ]),
    );

    // The effective difficulty applied to the reward formula is the validator
    // difficulty scaled by the automatic post-Genesis (>25%) supply ramp. Read
    // it from the contract; tolerate older deployments without the view.
    let effectiveDifficulty = BigInt(baseDifficulty);
    let supplyMultiplier = 10000n; // RAMP_SCALE — 1.0x
    try {
      [effectiveDifficulty, supplyMultiplier] = await withRetry(() =>
        Promise.all([
          this.token.effectiveDifficulty().then((v) => BigInt(v)),
          this.token.supplyDifficultyMultiplier().then((v) => BigInt(v)),
        ]),
      );
    } catch (_) {
      /* pre-ramp contract — fall back to the base difficulty */
    }

    return {
      // `difficulty` reports the effective (ramped) divisor so every consumer
      // — web miner, Telegram /network, terminal — sees the real difficulty.
      difficulty: effectiveDifficulty,
      baseDifficulty: BigInt(baseDifficulty),
      supplyDifficultyMultiplier: supplyMultiplier,
      totalMinted: BigInt(totalMinted),
      maxSupply: BigInt(maxSupply),
      epoch: Number(epoch),
      baseReward: BigInt(baseReward),
    };
  }

  /** On-chain preview of the reward (in wei) for a given W and integer Q. */
  async previewReward(workload, qualityInt) {
    this._assertToken();
    return BigInt(await withRetry(() => this.token.previewReward(workload, qualityInt)));
  }

  /** Read a wallet's AXIS balance (in wei). */
  async balanceOf(wallet) {
    this._assertToken();
    return BigInt(await withRetry(() => this.token.balanceOf(wallet)));
  }

  /**
   * Submits a verified PoAIW proof on-chain via the ValidatorRegistry. Requires
   * a configured validator signer.
   * @returns {{ txHash: string, minted: bigint }}
   */
  async submitWork(wallet, workload, qualityInt) {
    if (!this.registry || !this.signer) {
      throw new Error("Validator signer/registry not configured for on-chain submission");
    }
    logger.info("Submitting work on-chain", { wallet, workload, qualityInt });
    const tx = await this.registry.submitWork(wallet, workload, qualityInt);
    const receipt = await tx.wait();

    // Decode the WorkSubmitted event to recover the minted amount.
    let minted = 0n;
    for (const log of receipt.logs) {
      try {
        const parsed = this.registry.interface.parseLog(log);
        if (parsed && parsed.name === "WorkSubmitted") {
          minted = BigInt(parsed.args.mintedAmount);
          break;
        }
      } catch (_) {
        /* not a registry event */
      }
    }
    return { txHash: receipt.hash, minted };
  }
}

module.exports = new ChainClient();
module.exports.ChainClient = ChainClient;
