"use strict";

const redis = require("../redis/client");
const config = require("../config");

/**
 * Peer-sample cache and cross-checking helpers (whitepaper 5.2 — peer
 * validation sets). Recent submissions per work type are cached in Redis so the
 * pipeline can randomly sample prior submissions of the same type and
 * cross-check the new submission for consistency.
 *
 * Additionally maintains per-batch label distributions (dataset_labeling) and
 * per-target rating lists (peer_validation) used by those scoring functions.
 */

const RECENT_KEY = (workType) => `peer:recent:${workType}`;
const BATCH_KEY = (batchId) => `peer:batch:${batchId}`;
const TARGET_KEY = (target) => `peer:target:${target}`;

/**
 * Records a (scored) submission into the peer cache for its work type.
 * @param {string} workType
 * @param {object} record { jobId, wallet, quality, outputHash }
 */
async function recordSubmission(workType, record) {
  await redis.lpush(RECENT_KEY(workType), JSON.stringify(record));
  await redis.ltrim(RECENT_KEY(workType), 0, config.verification.peerCacheLimit - 1);
}

/**
 * Randomly samples up to N prior submissions of the same work type.
 * @param {string} workType
 * @param {number} [n]
 * @returns {Array<object>}
 */
async function samplePeers(workType, n = config.verification.peerSampleSize) {
  const len = await redis.llen(RECENT_KEY(workType));
  if (len === 0) return [];
  const picks = new Set();
  const take = Math.min(n, len);
  while (picks.size < take) {
    picks.add(Math.floor(Math.random() * len));
  }
  const results = [];
  for (const idx of picks) {
    const raw = await redis.lindex(RECENT_KEY(workType), idx);
    if (raw) {
      try {
        results.push(JSON.parse(raw));
      } catch (_) {
        /* skip malformed */
      }
    }
  }
  return results;
}

/**
 * Cross-checks a candidate quality against a peer sample. Returns a peer
 * consistency score in [0,1]: 1 when the candidate is in line with peers, lower
 * when it is a sharp outlier (possible fraud signal).
 *
 * @param {number} candidateQuality
 * @param {Array<object>} peers
 * @returns {{ peerScore: number, peerMean: number, sampled: number }}
 */
function crossCheck(candidateQuality, peers) {
  if (!peers || peers.length === 0) {
    return { peerScore: 1, peerMean: candidateQuality, sampled: 0 };
  }
  const qualities = peers.map((p) => Number(p.quality)).filter(Number.isFinite);
  if (qualities.length === 0) {
    return { peerScore: 1, peerMean: candidateQuality, sampled: 0 };
  }
  const mean = qualities.reduce((a, b) => a + b, 0) / qualities.length;
  const deviation = Math.abs(candidateQuality - mean);
  // Deviation up to 1.0 possible; consistency degrades linearly.
  const peerScore = Math.max(0, 1 - deviation);
  return { peerScore, peerMean: mean, sampled: qualities.length };
}

// ---- dataset_labeling batch distributions ---- //

async function recordBatchLabels(batchId, labels) {
  if (!batchId) return;
  const key = BATCH_KEY(batchId);
  for (const [item, label] of Object.entries(labels || {})) {
    await redis.hincrby(key, `${item}::${label}`, 1);
  }
  await redis.expire(key, 86400);
}

async function getBatchLabelDistribution(batchId) {
  if (!batchId) return {};
  const flat = await redis.hgetall(BATCH_KEY(batchId));
  const dist = {};
  for (const [field, count] of Object.entries(flat)) {
    const sep = field.lastIndexOf("::");
    const item = field.slice(0, sep);
    const label = field.slice(sep + 2);
    dist[item] = dist[item] || {};
    dist[item][label] = parseInt(count, 10);
  }
  return dist;
}

// ---- peer_validation target ratings ---- //

async function recordTargetRating(target, rating) {
  if (!target) return;
  await redis.lpush(TARGET_KEY(target), String(rating));
  await redis.ltrim(TARGET_KEY(target), 0, 99);
  await redis.expire(TARGET_KEY(target), 86400);
}

async function getTargetRatings(target) {
  if (!target) return [];
  const raw = await redis.lrange(TARGET_KEY(target), 0, -1);
  return raw.map(Number).filter(Number.isFinite);
}

module.exports = {
  recordSubmission,
  samplePeers,
  crossCheck,
  recordBatchLabels,
  getBatchLabelDistribution,
  recordTargetRating,
  getTargetRatings,
};
