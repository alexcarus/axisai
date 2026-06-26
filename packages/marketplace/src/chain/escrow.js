"use strict";

const { ethers } = require("ethers");
const config = require("../config");
const logger = require("../logger");

const ESCROW_ABI = [
  "function lock(bytes32 jobId, address provider, uint256 amount, uint256 timeoutSec)",
  "function release(bytes32 jobId)",
  "function refund(bytes32 jobId)",
  "function flagFraud(bytes32 jobId)",
  "function getEscrow(bytes32 jobId) view returns (tuple(bytes32 jobId,address requester,address provider,uint256 amount,uint256 createdAt,uint256 timeoutAt,uint8 status))",
];
const TOKEN_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
// The operator is a validator, so it can mint an AXIS settlement treasury via
// the registry's PoAIW path to fund market payouts.
const REGISTRY_ABI = [
  "function submitWork(address miner, uint256 workload, uint256 quality) returns (uint256)",
];

/**
 * On-chain escrow/token client. Settlement calls (release/refund/flagFraud) are
 * authorised by the validator-operator key. All methods are best-effort and
 * guarded — the marketplace DB remains the authoritative record, with the chain
 * mirrored when `ESCROW_ONCHAIN=true`.
 */
class EscrowChain {
  constructor() {
    this.enabled = config.chain.onchain;
    this.provider = new ethers.JsonRpcProvider(config.chain.rpcUrl);
    if (config.chain.operatorPrivateKey) {
      this.signer = new ethers.Wallet(config.chain.operatorPrivateKey, this.provider);
      this.escrow = config.chain.escrowAddress
        ? new ethers.Contract(config.chain.escrowAddress, ESCROW_ABI, this.signer)
        : null;
      this.token = config.chain.tokenAddress
        ? new ethers.Contract(config.chain.tokenAddress, TOKEN_ABI, this.signer)
        : null;
      this.registry = config.chain.registryAddress
        ? new ethers.Contract(config.chain.registryAddress, REGISTRY_ABI, this.signer)
        : null;
    }
    // Serializes settlement tx sequences so the operator's nonces never race.
    this._chain = Promise.resolve();
  }

  /** Maps an off-chain job UUID to the bytes32 id used by the escrow contract. */
  static jobKey(jobId) {
    return ethers.keccak256(ethers.toUtf8Bytes(String(jobId)));
  }

  async release(jobId) {
    if (!this.enabled || !this.escrow) return { txHash: null, onchain: false };
    try {
      const tx = await this.escrow.release(EscrowChain.jobKey(jobId));
      const r = await tx.wait();
      return { txHash: r.hash, onchain: true };
    } catch (err) {
      logger.error("on-chain release failed", { jobId, error: err.message });
      return { txHash: null, onchain: false, error: err.message };
    }
  }

  async refund(jobId) {
    if (!this.enabled || !this.escrow) return { txHash: null, onchain: false };
    try {
      const tx = await this.escrow.refund(EscrowChain.jobKey(jobId));
      const r = await tx.wait();
      return { txHash: r.hash, onchain: true };
    } catch (err) {
      logger.error("on-chain refund failed", { jobId, error: err.message });
      return { txHash: null, onchain: false, error: err.message };
    }
  }

  async flagFraud(jobId) {
    if (!this.enabled || !this.escrow) return { txHash: null, onchain: false };
    try {
      const tx = await this.escrow.flagFraud(EscrowChain.jobKey(jobId));
      const r = await tx.wait();
      return { txHash: r.hash, onchain: true };
    } catch (err) {
      logger.error("on-chain flagFraud failed", { jobId, error: err.message });
      return { txHash: null, onchain: false, error: err.message };
    }
  }

  /** Optional on-chain AXIS transfer for capacity settlement (operator-funded). */
  async transfer(to, amountAxis) {
    if (!this.enabled || !this.token) return { txHash: null, onchain: false };
    try {
      const tx = await this.token.transfer(to, ethers.parseEther(String(amountAxis)));
      const r = await tx.wait();
      return { txHash: r.hash, onchain: true };
    } catch (err) {
      logger.error("on-chain transfer failed", { to, error: err.message });
      return { txHash: null, onchain: false, error: err.message };
    }
  }

  /** Operator (validator) address used to fund and authorise settlement. */
  operatorAddress() {
    return this.signer ? this.signer.address : null;
  }

  /**
   * Routes a miner's market-fee share on-chain THROUGH ESCROW: the operator
   * funds an AXIS treasury (via the registry's PoAIW mint) if short, locks the
   * miner's `amountWei` share, then (as a validator) releases it to the miner.
   * Settlements are serialized + use explicit nonces so concurrent fills (and
   * the engine sharing the operator key) never collide.
   * @returns {Promise<{onchain:boolean, lock_tx?:string, release_tx?:string, miner_axis?:string, error?:string}>}
   */
  async settleMinerShare(fillId, minerWallet, amountWei) {
    if (!this.enabled || !this.escrow || !this.token || !this.registry) {
      return { onchain: false };
    }
    if (!ethers.isAddress(minerWallet)) {
      return { onchain: false, error: "miner wallet is not an on-chain address" };
    }
    if (amountWei <= 0n) return { onchain: false, error: "zero miner share" };
    const run = this._chain.then(() =>
      this._settleWithRetry(fillId, minerWallet, amountWei),
    );
    this._chain = run.catch(() => {});
    return run;
  }

  async _settleWithRetry(fillId, minerWallet, amountWei) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this._settleOnce(fillId, minerWallet, amountWei);
      } catch (err) {
        // A shared-key nonce collision is transient — refetch the nonce + retry.
        if (attempt < 2 && /nonce/i.test(err.message || "")) continue;
        logger.error("on-chain miner settlement failed", {
          fillId,
          error: err.message,
        });
        return { onchain: false, error: err.message };
      }
    }
  }

  async _settleOnce(fillId, minerWallet, amountWei) {
    let nonce = await this.provider.getTransactionCount(this.signer.address, "latest");
    const next = () => ({ nonce: nonce++ });

    // Fund the operator treasury if short (mint via PoAIW).
    for (let i = 0; i < 4; i++) {
      const bal = await this.token.balanceOf(this.signer.address);
      if (bal >= amountWei) break;
      logger.info("market: minting settlement treasury to operator");
      await (
        await this.registry.submitWork(this.signer.address, 50n, 100n, next())
      ).wait();
    }

    const key = EscrowChain.jobKey(`market:${fillId}`);
    await (
      await this.token.approve(config.chain.escrowAddress, amountWei, next())
    ).wait();
    const lockReceipt = await (
      await this.escrow.lock(key, minerWallet, amountWei, 300n, next())
    ).wait();
    const releaseReceipt = await (await this.escrow.release(key, next())).wait();

    return {
      onchain: true,
      lock_tx: lockReceipt.hash,
      release_tx: releaseReceipt.hash,
      miner_axis: ethers.formatEther(amountWei),
    };
  }
}

module.exports = new EscrowChain();
