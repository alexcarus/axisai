"use strict";

const redis = require("./redis");

// Per-miner reputation: jobs served, results rejected, AXIS earned, last seen.
// Used to rank miners and to temporarily gate persistently-bad ones.
const TTL = 60 * 60 * 24 * 90; // 90 days
const LB = "cm:miners:lb"; // sorted set: score = served count
const key = (a) => `cm:miner:${String(a).toLowerCase()}`;

async function recordServed(miner, paidAxis) {
  const a = String(miner).toLowerCase();
  const served = await redis.hincrby(key(a), "served", 1);
  await redis.hincrbyfloat(key(a), "earned_axis", Number(paidAxis) || 0);
  await redis.hset(key(a), "last_seen", String(Date.now()));
  await redis.expire(key(a), TTL);
  await redis.zadd(LB, served, a);
}

async function recordRejected(miner) {
  const a = String(miner).toLowerCase();
  await redis.hincrby(key(a), "rejected", 1);
  await redis.hset(key(a), "last_seen", String(Date.now()));
  await redis.expire(key(a), TTL);
}

async function getMiner(addr) {
  const h = (await redis.hgetall(key(addr))) || {};
  const served = Number(h.served || 0);
  const rejected = Number(h.rejected || 0);
  const total = served + rejected;
  return {
    address: String(addr).toLowerCase(),
    served,
    rejected,
    earned_axis: Number(h.earned_axis || 0),
    reject_rate: total > 0 ? rejected / total : 0,
    last_seen: h.last_seen ? Number(h.last_seen) : null,
  };
}

async function topMiners(n = 20) {
  const arr = await redis.zrevrange(LB, 0, n - 1, "WITHSCORES");
  const out = [];
  for (let i = 0; i < arr.length; i += 2) {
    out.push({ address: arr[i], served: Number(arr[i + 1]) });
  }
  return out;
}

/** Persistently-bad miners are temporarily blocked from claiming new jobs. */
async function isBlocked(addr) {
  const m = await getMiner(addr);
  const total = m.served + m.rejected;
  return total >= 4 && m.reject_rate > 0.5;
}

module.exports = { recordServed, recordRejected, getMiner, topMiners, isBlocked };
