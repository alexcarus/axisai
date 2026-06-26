"use strict";

const winston = require("winston");
const config = require("./config");

module.exports = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: "axis-marketplace" },
  transports: [new winston.transports.Console()],
});
