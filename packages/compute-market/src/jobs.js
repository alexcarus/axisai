"use strict";

const crypto = require("node:crypto");
const redis = require("./redis");

// Redis keys: a FIFO queue of pending job ids + a record per job.
const QUEUE = "cm:queue";
const JOB_TTL = 60 * 60 * 24; // jobs live 24h
const key = (id) => `cm:job:${id}`;

/** Creates a paid job and enqueues it for miners to claim. Returns the job id. */
async function createJob({ model, prompt, paidWei, minerShareWei }) {
  const id = crypto.randomUUID();
  const job = {
    id,
    model,
    prompt,
    status: "queued",
    paid_wei: paidWei.toString(),
    miner_share_wei: minerShareWei.toString(),
    output: null,
    miner: null,
    payout_tx: null,
    created_at: Date.now(),
  };
  await redis.set(key(id), JSON.stringify(job), "EX", JOB_TTL);
  await redis.lpush(QUEUE, id);
  return id;
}

async function getJob(id) {
  const raw = await redis.get(key(id));
  return raw ? JSON.parse(raw) : null;
}

async function saveJob(job) {
  await redis.set(key(job.id), JSON.stringify(job), "EX", JOB_TTL);
}

/**
 * Atomically claims the next queued job for `miner`. RPOP is atomic, so two
 * miners can never claim the same job. Returns the job, or null if none queued.
 */
async function claimNext(miner) {
  const id = await redis.rpop(QUEUE);
  if (!id) return null;
  const job = await getJob(id);
  if (!job) return null;
  job.status = "claimed";
  job.miner = miner;
  job.claimed_at = Date.now();
  await saveJob(job);
  return job;
}

/** Returns a rejected job to the queue for another miner to try. */
async function requeue(job) {
  job.status = "queued";
  job.miner = null;
  await saveJob(job);
  await redis.lpush(QUEUE, job.id);
}

/**
 * Returns the oldest still-queued job (the tail — FIFO) without removing it, so
 * the operator-direct fallback can check its age before deciding to serve it.
 * Cleans a stale queue entry whose job record has expired.
 */
async function peekOldestQueued() {
  const id = await redis.lindex(QUEUE, -1);
  if (!id) return null;
  const job = await getJob(id);
  if (!job) {
    await redis.lrem(QUEUE, 1, id);
    return null;
  }
  return job;
}

/**
 * Atomically claims a SPECIFIC queued job for the operator-direct fallback.
 * `LREM` removes the id by value; if a distributed miner already popped it,
 * LREM returns 0 and we return null — so a job is never served twice.
 */
async function claimForOperator(id) {
  const removed = await redis.lrem(QUEUE, 1, id);
  if (!removed) return null;
  const job = await getJob(id);
  if (!job) return null;
  job.status = "claimed";
  job.miner = "operator";
  job.claimed_at = Date.now();
  await saveJob(job);
  return job;
}

module.exports = {
  createJob,
  getJob,
  saveJob,
  claimNext,
  requeue,
  peekOldestQueued,
  claimForOperator,
};
