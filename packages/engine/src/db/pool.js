"use strict";

const { Pool } = require("pg");
const config = require("../config");
const logger = require("../logger");

/**
 * Shared PostgreSQL connection pool for the verification engine.
 */
const pool = new Pool({
  connectionString: config.postgres.connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on("error", (err) => {
  logger.error("Unexpected PostgreSQL pool error", { error: err.message });
});

/**
 * Executes a parameterised query and returns the result.
 * @param {string} text SQL text with $1..$n placeholders.
 * @param {Array} params Bound parameters.
 */
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  logger.debug("db query", { ms: Date.now() - start, rows: res.rowCount });
  return res;
}

module.exports = { pool, query };
