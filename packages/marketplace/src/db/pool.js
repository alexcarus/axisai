"use strict";

const { Pool } = require("pg");
const config = require("../config");
const logger = require("../logger");

const pool = new Pool({ connectionString: config.postgres.connectionString, max: 12 });
pool.on("error", (err) => logger.error("PG pool error (marketplace)", { error: err.message }));

async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

module.exports = { pool, query };
