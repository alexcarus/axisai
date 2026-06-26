"use strict";

const { buildSubmission, buildAuthHeaders } = require("./wallet");

/**
 * Thin client for the AXIS API Gateway, used by both messaging interfaces. Uses
 * the global fetch (Node 18+). All read calls attach signed auth headers; the
 * submit call attaches a fully-signed submission body.
 */
class GatewayClient {
  /**
   * @param {string} baseUrl Gateway base URL (e.g. http://localhost:3000).
   * @param {ethers.JsonRpcProvider|null} provider Optional provider for block height.
   */
  constructor(baseUrl, provider = null) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.provider = provider;
  }

  async _blockHeight() {
    if (!this.provider) return 0;
    try {
      return await this.provider.getBlockNumber();
    } catch (_) {
      return 0;
    }
  }

  async _get(path, wallet) {
    const headers = await buildAuthHeaders(wallet);
    const res = await fetch(`${this.baseUrl}${path}`, { method: "GET", headers });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  /** Submit work on behalf of a user's mining wallet. */
  async submit(wallet, workType, outputDataString, channel) {
    const blockHeight = await this._blockHeight();
    const body = await buildSubmission(wallet, workType, outputDataString, {
      blockHeight,
      channel,
    });
    const res = await fetch(`${this.baseUrl}/gateway/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-channel": channel },
      body: JSON.stringify(body),
    });
    const respBody = await res.json().catch(() => ({}));
    return { status: res.status, body: respBody };
  }

  status(wallet, jobId) {
    return this._get(`/gateway/status/${encodeURIComponent(jobId)}`, wallet);
  }

  miner(wallet, address) {
    return this._get(`/gateway/miner/${encodeURIComponent(address || wallet.address)}`, wallet);
  }

  networkStats(wallet) {
    return this._get(`/gateway/network/stats`, wallet);
  }

  leaderboard(wallet) {
    return this._get(`/gateway/leaderboard`, wallet);
  }
}

module.exports = { GatewayClient };
