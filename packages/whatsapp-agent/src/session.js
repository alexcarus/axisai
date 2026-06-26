"use strict";

const redis = require("./redis");

/**
 * Redis-backed per-user conversation session (keyed by WhatsApp id). Stores the
 * current flow state and transient values (e.g. last selected work type).
 */
const KEY = (waId) => `wa:session:${waId}`;
const TTL = 3600;

async function getSession(waId) {
  const raw = await redis.get(KEY(waId));
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

async function setSession(waId, session) {
  await redis.set(KEY(waId), JSON.stringify(session), "EX", TTL);
}

async function updateSession(waId, patch) {
  const s = await getSession(waId);
  const next = { ...s, ...patch };
  await setSession(waId, next);
  return next;
}

// Submit cooldown (cross-checked again at the gateway).
const COOLDOWN_KEY = (waId) => `wa:cooldown:${waId}`;

async function getCooldown(waId, seconds) {
  const exists = await redis.exists(COOLDOWN_KEY(waId));
  if (!exists) return 0;
  const ttl = await redis.ttl(COOLDOWN_KEY(waId));
  return ttl > 0 ? ttl : 0;
}

async function markCooldown(waId, seconds) {
  await redis.set(COOLDOWN_KEY(waId), "1", "EX", seconds);
}

module.exports = { getSession, setSession, updateSession, getCooldown, markCooldown };
