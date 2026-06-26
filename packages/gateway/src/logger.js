"use strict";

const winston = require("winston");
const config = require("./config");

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: "axis-gateway" },
  transports: [new winston.transports.Console()],
});

module.exports = logger;
