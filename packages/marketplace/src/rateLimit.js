"use strict";

const redis = require("./redis");

/**
 * Lightweight fixed-window per-key rate limiter backed by Redis.
 *
 * The market endpoints are public and unauthenticated; without a limit anyone
 * could flood the persistent `market_fills` ledger (storage/cost) or, when
 * on-chain settlement is enabled, spam bounded on-chain settlements. This bounds
 * the request rate per client.
 *
 * Fails OPEN on a Redis outage — availability is preferred over strictness for
 * this informational/sim market, and the on-chain path already has its own hard
 * per-fill and amount caps.
 *
 * @returns {Promise<{ allowed: boolean, count: number, limit: number }>}
 */
async function limit(key, max, windowSeconds) {
  const k = `mkt:rl:${key}`;
  try {
    const count = await redis.incr(k);
    if (count === 1) await redis.expire(k, windowSeconds);
    return { allowed: count <= max, count, limit: max };
  } catch (_) {
    return { allowed: true, count: 0, limit: max };
  }
}

/** Resolves the client IP, honouring X-Forwarded-For (best effort). */
function clientIp(req) {
  return (
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

module.exports = { limit, clientIp };
