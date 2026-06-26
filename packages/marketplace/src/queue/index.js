"use strict";

const Queue = require("bull");
const config = require("../config");

const redisOpts = {
  redis: {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
  },
  defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 3000 }, removeOnComplete: 500, removeOnFail: 500 },
};

/** Queue for async provider matching of new compute job requests. */
const matchQueue = new Queue("marketplace-match", redisOpts);

/** Queue for delayed job-timeout refunds. */
const timeoutQueue = new Queue("marketplace-timeout", redisOpts);

module.exports = { matchQueue, timeoutQueue };
