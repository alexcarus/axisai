"use strict";

const Queue = require("bull");
const config = require("../config");

/**
 * Bull queue used to process verification jobs asynchronously. Producers
 * (the /submit route) add jobs; the worker consumes and runs the pipeline.
 */
const verificationQueue = new Queue(config.queue.name, {
  redis: {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
  },
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 1000,
  },
});

module.exports = verificationQueue;
