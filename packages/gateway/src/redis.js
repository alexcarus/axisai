"use strict";

const Redis = require("ioredis");
const config = require("./config");
const logger = require("./logger");

const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
});

redis.on("connect", () => logger.info("Redis connected (gateway)"));
redis.on("error", (err) => logger.error("Redis error (gateway)", { error: err.message }));

module.exports = redis;
