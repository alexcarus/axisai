"use strict";

const { Pool } = require("pg");
const config = require("./config");
const logger = require("./logger");

/**
 * PostgreSQL pool for the gateway's audit trail and review flags.
 */
const pool = new Pool({ connectionString: config.postgres.connectionString, max: 10 });

pool.on("error", (err) => logger.error("PG pool error (gateway)", { error: err.message }));

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS gateway_audit_log (
     id            BIGSERIAL PRIMARY KEY,
     channel       TEXT,
     wallet        TEXT,
     work_type     TEXT,
     ip_address    TEXT,
     route         TEXT,
     result        TEXT,           -- approved | rejected | error | forwarded
     detail        TEXT,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,
  `CREATE INDEX IF NOT EXISTS idx_audit_wallet ON gateway_audit_log (wallet);`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created ON gateway_audit_log (created_at);`,

  `CREATE TABLE IF NOT EXISTS gateway_review_flags (
     id          BIGSERIAL PRIMARY KEY,
     wallet      TEXT NOT NULL,
     reason      TEXT NOT NULL,
     detail      JSONB,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,
  `CREATE INDEX IF NOT EXISTS idx_flags_wallet ON gateway_review_flags (wallet);`,
];

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const sql of STATEMENTS) await client.query(sql);
    await client.query("COMMIT");
    logger.info("Gateway database migration complete");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Writes one audit row. Never throws into the request path.
 */
async function audit(entry) {
  try {
    await pool.query(
      `INSERT INTO gateway_audit_log (channel, wallet, work_type, ip_address, route, result, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        entry.channel || null,
        entry.wallet ? entry.wallet.toLowerCase() : null,
        entry.work_type || null,
        entry.ip || null,
        entry.route || null,
        entry.result || null,
        entry.detail || null,
      ]
    );
  } catch (err) {
    logger.error("audit write failed", { error: err.message });
  }
}

/**
 * Records a wallet for manual review.
 */
async function flagForReview(wallet, reason, detail = {}) {
  try {
    await pool.query(
      `INSERT INTO gateway_review_flags (wallet, reason, detail) VALUES ($1,$2,$3)`,
      [wallet.toLowerCase(), reason, JSON.stringify(detail)]
    );
    logger.warn("wallet flagged for review", { wallet, reason });
  } catch (err) {
    logger.error("flag write failed", { error: err.message });
  }
}

if (require.main === module && process.argv.includes("--migrate")) {
  migrate()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error("migration failed", { error: e.message });
      process.exit(1);
    });
}

module.exports = { pool, migrate, audit, flagForReview };
