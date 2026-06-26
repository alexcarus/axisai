"use strict";

const Redis = require("ioredis");
const config = require("../config");
const logger = require("../logger");

/**
 * Shared Redis client used for cooldown tracking, peer-sample caching and
 * job-state hints. Bull manages its own connections separately.
 */
const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redis.on("connect", () => logger.info("Redis connected (engine)"));
redis.on("error", (err) => logger.error("Redis error (engine)", { error: err.message }));

module.exports = redis;
