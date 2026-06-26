"use strict";

const { pool } = require("./pool");
const logger = require("../logger");

/**
 * Marketplace schema (whitepaper sections 7 & 9). Idempotent; safe to re-run.
 */
const STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS "pgcrypto";`,

  // ---- Model registry ----
  `CREATE TABLE IF NOT EXISTS models (
     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     name          TEXT NOT NULL,
     description   TEXT,
     input_schema  JSONB,
     output_schema JSONB,
     work_type     TEXT NOT NULL,
     price_in_axis NUMERIC(40,18) NOT NULL,
     owner_wallet  TEXT NOT NULL,
     fingerprint   TEXT,
     rating_avg    DOUBLE PRECISION NOT NULL DEFAULT 0,
     rating_count  INTEGER NOT NULL DEFAULT 0,
     usage_count   INTEGER NOT NULL DEFAULT 0,
     active        BOOLEAN NOT NULL DEFAULT true,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,
  `CREATE INDEX IF NOT EXISTS idx_models_worktype ON models (work_type);`,
  `CREATE INDEX IF NOT EXISTS idx_models_price ON models (price_in_axis);`,

  `CREATE TABLE IF NOT EXISTS model_ratings (
     id         BIGSERIAL PRIMARY KEY,
     model_id   UUID REFERENCES models(id) ON DELETE CASCADE,
     wallet     TEXT NOT NULL,
     stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (model_id, wallet)
   );`,

  // ---- Compute jobs ----
  `CREATE TABLE IF NOT EXISTS jobs (
     id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     model_id            UUID REFERENCES models(id),
     requester_wallet    TEXT NOT NULL,
     provider_wallet     TEXT,
     input_data          TEXT,
     input_hash          TEXT,
     output_data         TEXT,
     output_hash         TEXT,
     work_type           TEXT,
     max_price_in_axis   NUMERIC(40,18) NOT NULL,
     price_in_axis       NUMERIC(40,18),
     status              TEXT NOT NULL DEFAULT 'requested',
     verification_status TEXT,
     quality             DOUBLE PRECISION,
     settlement_tx       TEXT,
     escrow_id           UUID,
     deadline            TIMESTAMPTZ,
     created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
     delivered_at        TIMESTAMPTZ,
     settled_at          TIMESTAMPTZ
   );`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_requester ON jobs (requester_wallet);`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_provider ON jobs (provider_wallet);`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);`,

  // ---- TX capacity exchange ----
  `CREATE TABLE IF NOT EXISTS capacity_offers (
     id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     provider_wallet   TEXT NOT NULL,
     tx_units          BIGINT NOT NULL,
     remaining_units   BIGINT NOT NULL,
     price_per_tx_axis NUMERIC(40,18) NOT NULL,
     expiry            TIMESTAMPTZ NOT NULL,
     active            BOOLEAN NOT NULL DEFAULT true,
     created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,
  `CREATE INDEX IF NOT EXISTS idx_capacity_price ON capacity_offers (price_per_tx_axis);`,

  `CREATE TABLE IF NOT EXISTS capacity_purchases (
     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     offer_id    UUID REFERENCES capacity_offers(id),
     buyer_wallet TEXT NOT NULL,
     units       BIGINT NOT NULL,
     total_price_axis NUMERIC(40,18) NOT NULL,
     tx_hash     TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,

  // ---- Pricing time series ----
  `CREATE TABLE IF NOT EXISTS price_snapshots (
     id             BIGSERIAL PRIMARY KEY,
     ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
     demand_units   NUMERIC NOT NULL,
     capacity_units NUMERIC NOT NULL,
     base_price     NUMERIC(40,18) NOT NULL,
     price          NUMERIC(40,18) NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS idx_price_ts ON price_snapshots (ts);`,

  // ---- Escrow ----
  `CREATE TABLE IF NOT EXISTS escrows (
     id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     job_id           UUID,
     requester_wallet TEXT NOT NULL,
     provider_wallet  TEXT NOT NULL,
     amount_axis      NUMERIC(40,18) NOT NULL,
     status           TEXT NOT NULL DEFAULT 'locked',
     tx_hash          TEXT,
     created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
     timeout_at       TIMESTAMPTZ NOT NULL,
     settled_at       TIMESTAMPTZ
   );`,
  `CREATE TABLE IF NOT EXISTS escrow_events (
     id         BIGSERIAL PRIMARY KEY,
     escrow_id  UUID,
     job_id     UUID,
     event_type TEXT NOT NULL,
     amount_axis NUMERIC(40,18),
     tx_hash    TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,

  // ---- AXIS Market (AI trading) ----
  `CREATE TABLE IF NOT EXISTS market_fills (
     id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     side          TEXT NOT NULL,
     asset         TEXT NOT NULL DEFAULT 'AXIS',
     amount        NUMERIC(40,18) NOT NULL,
     price         NUMERIC(40,18) NOT NULL,
     notional      NUMERIC(40,18) NOT NULL,
     fee           NUMERIC(40,18) NOT NULL,
     lp_fee        NUMERIC(40,18) NOT NULL,
     miner_fee     NUMERIC(40,18) NOT NULL,
     ai_saved      NUMERIC(40,18) NOT NULL DEFAULT 0,
     trader_wallet TEXT,
     miner_wallet  TEXT,
     pnl           NUMERIC(40,18) NOT NULL DEFAULT 0,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,
  `CREATE INDEX IF NOT EXISTS idx_market_fills_ts ON market_fills (created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_market_fills_miner ON market_fills (miner_wallet);`,
  // On-chain settlement of the miner's fee share (escrow release).
  `ALTER TABLE market_fills ADD COLUMN IF NOT EXISTS miner_axis NUMERIC(40,18) NOT NULL DEFAULT 0;`,
  `ALTER TABLE market_fills ADD COLUMN IF NOT EXISTS settlement_tx TEXT;`,

  // ---- Reputation ----
  `CREATE TABLE IF NOT EXISTS reputation (
     wallet               TEXT PRIMARY KEY,
     provider_score       DOUBLE PRECISION NOT NULL DEFAULT 0,
     requester_score      DOUBLE PRECISION NOT NULL DEFAULT 0,
     jobs_completed       INTEGER NOT NULL DEFAULT 0,
     jobs_failed          INTEGER NOT NULL DEFAULT 0,
     verifications_passed INTEGER NOT NULL DEFAULT 0,
     verifications_failed INTEGER NOT NULL DEFAULT 0,
     total_delivery_secs  BIGINT NOT NULL DEFAULT 0,
     delivery_samples     INTEGER NOT NULL DEFAULT 0,
     payments_made        INTEGER NOT NULL DEFAULT 0,
     disputes             INTEGER NOT NULL DEFAULT 0,
     updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,
];

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const sql of STATEMENTS) await client.query(sql);
    await client.query("COMMIT");
    logger.info("Marketplace database migration complete");
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error("Marketplace migration failed", { error: err.message });
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
