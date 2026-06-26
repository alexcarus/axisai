"use strict";

const winston = require("winston");
const config = require("./config");

/**
 * Shared Winston logger. Every pipeline step logs through this instance so that
 * submissions can be traced end-to-end. Structured metadata is preserved.
 */
const logger = winston.createLogger({
  level: config.log.level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: "axis-engine" },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const rest = Object.keys(meta).filter((k) => k !== "service");
          const metaStr = rest.length
            ? " " + JSON.stringify(Object.fromEntries(rest.map((k) => [k, meta[k]])))
            : "";
          return `${timestamp} [${level}] ${message}${metaStr}`;
        })
      ),
    }),
  ],
});

module.exports = logger;
