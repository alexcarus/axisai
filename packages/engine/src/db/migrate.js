"use strict";

const { pool } = require("./pool");
const logger = require("../logger");

/**
 * Idempotent schema migration for the verification engine. Creates every table
 * the engine, gateway and bots rely on. Safe to run repeatedly.
 *
 * NOTE: the `users` and `miners` tables are shared with the Telegram bot and
 * WhatsApp agent (whitepaper section 8 — interfaces are gateways, not owners).
 */
const STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS "pgcrypto";`,

  // Miners — one row per wallet, aggregate mining stats.
  `CREATE TABLE IF NOT EXISTS miners (
     wallet_address    TEXT PRIMARY KEY,
     total_submitted   BIGINT NOT NULL DEFAULT 0,
     total_verified    BIGINT NOT NULL DEFAULT 0,
     total_rejected    BIGINT NOT NULL DEFAULT 0,
     total_axis_earned NUMERIC(40,18) NOT NULL DEFAULT 0,
     first_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,

  // Users — links a messaging-channel identity to a wallet (shared by bots).
  `CREATE TABLE IF NOT EXISTS users (
     id             BIGSERIAL PRIMARY KEY,
     channel        TEXT NOT NULL,
     channel_user_id TEXT NOT NULL,
     wallet_address TEXT NOT NULL,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (channel, channel_user_id)
   );`,

  // Submissions — full lifecycle of every work submission.
  `CREATE TABLE IF NOT EXISTS submissions (
     id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     job_id         TEXT UNIQUE NOT NULL,
     wallet_address TEXT NOT NULL,
     work_type      TEXT NOT NULL,
     input_hash     TEXT,
     output_hash    TEXT,
     status         TEXT NOT NULL DEFAULT 'pending',
     quality        DOUBLE PRECISION,
     workload       BIGINT,
     difficulty     BIGINT,
     reward         NUMERIC(40,18) DEFAULT 0,
     reward_int     BIGINT,
     epoch          INTEGER,
     tx_hash        TEXT,
     reject_reason  TEXT,
     signature      TEXT,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,

  // Upgrade path for pre-existing databases.
  `ALTER TABLE submissions ADD COLUMN IF NOT EXISTS signature TEXT;`,

  `CREATE INDEX IF NOT EXISTS idx_submissions_wallet ON submissions (wallet_address);`,
  `CREATE INDEX IF NOT EXISTS idx_submissions_worktype ON submissions (work_type);`,
  `CREATE INDEX IF NOT EXISTS idx_submissions_epoch ON submissions (epoch);`,
  `CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions (created_at);`,
  // Replay protection: the single-use submission signature must be unique.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_signature ON submissions (signature);`,

  // Scores — detailed scoring breakdown per submission.
  `CREATE TABLE IF NOT EXISTS scores (
     id            BIGSERIAL PRIMARY KEY,
     submission_id UUID REFERENCES submissions(id) ON DELETE CASCADE,
     work_type     TEXT NOT NULL,
     quality       DOUBLE PRECISION NOT NULL,
     peer_score    DOUBLE PRECISION,
     details       JSONB,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,
];

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    await client.query("COMMIT");
    logger.info("Engine database migration complete");
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error("Engine migration failed", { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { migrate };
