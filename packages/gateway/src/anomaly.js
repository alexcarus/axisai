"use strict";

const redis = require("./redis");
const config = require("./config");
const { flagForReview } = require("./db");

/**
 * Anomaly detection: if a single wallet submits from N+ distinct IP addresses
 * within the configured window (default 3 IPs / 1 hour), the wallet is flagged
 * for manual review.
 */

const IPSET_KEY = (wallet) => `gw:anomaly:ips:${wallet.toLowerCase()}`;

/**
 * Records the source IP for a wallet and flags the wallet if it has now been
 * seen from too many distinct IPs within the window.
 * @returns {Promise<{ distinctIps: number, flagged: boolean }>}
 */
async function trackWalletIp(wallet, ip) {
  const key = IPSET_KEY(wallet);
  await redis.sadd(key, ip);
  // (Re)set the rolling window each time we observe activity.
  await redis.expire(key, config.anomalyWindowSeconds);
  const distinctIps = await redis.scard(key);

  let flagged = false;
  if (distinctIps >= config.anomalyIpThreshold) {
    flagged = true;
    const ips = await redis.smembers(key);
    await flagForReview(wallet, "multi_ip_anomaly", {
      distinctIps,
      ips,
      windowSeconds: config.anomalyWindowSeconds,
    });
  }
  return { distinctIps, flagged };
}

module.exports = { trackWalletIp };
