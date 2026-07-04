"use strict";

const Redis = require("ioredis");
const config = require("./config");

// Single shared Redis connection for the queue + anti-replay.
const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: 3,
});
redis.on("error", (e) => console.error("[redis]", e.message));

module.exports = redis;
