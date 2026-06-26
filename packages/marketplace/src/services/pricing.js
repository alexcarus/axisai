"use strict";

const { query } = require("../db/pool");
const config = require("../config");
const logger = require("../logger");

/**
 * Pricing engine (whitepaper section 7.3): Compute Price ∝ Demand / Capacity.
 *
 * Every `intervalMs` (default 60s) it snapshots:
 *   - demand   = total open compute-job requests (units)
 *   - capacity = total available TX-capacity offer units
 * and computes:
 *   price = base_price × (demand / max(capacity, 1))
 * storing the snapshot in the `price_snapshots` time-series table.
 */
class PricingEngine {
  constructor() {
    this.timer = null;
    this.latest = null;
  }

  async snapshot() {
    // Demand: open job requests not yet settled. Each open job = 1 demand unit.
    const { rows: demandRows } = await query(
      `SELECT COUNT(*)::numeric AS demand FROM jobs
        WHERE status IN ('requested','matched','delivered','verifying')`
    );
    // Capacity: sum of remaining units across active, unexpired offers.
    const { rows: capRows } = await query(
      `SELECT COALESCE(SUM(remaining_units),0)::numeric AS capacity FROM capacity_offers
        WHERE active = true AND expiry > now() AND remaining_units > 0`
    );

    const demand = Number(demandRows[0].demand);
    const capacity = Number(capRows[0].capacity);
    const base = config.pricing.basePrice;
    const price = base * (demand / Math.max(capacity, 1));

    await query(
      `INSERT INTO price_snapshots (demand_units, capacity_units, base_price, price)
       VALUES ($1,$2,$3,$4)`,
      [demand, capacity, base, price]
    );

    this.latest = { demand, capacity, base_price: base, price, ts: new Date().toISOString() };
    logger.debug("pricing snapshot", this.latest);
    return this.latest;
  }

  start() {
    // Take an immediate snapshot, then on the interval.
    this.snapshot().catch((e) => logger.error("pricing snapshot failed", { error: e.message }));
    this.timer = setInterval(() => {
      this.snapshot().catch((e) => logger.error("pricing snapshot failed", { error: e.message }));
    }, config.pricing.intervalMs);
    logger.info("pricing engine started", { intervalMs: config.pricing.intervalMs });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async current() {
    if (this.latest) return this.latest;
    return this.snapshot();
  }

  async history(hours) {
    const { rows } = await query(
      `SELECT ts, demand_units, capacity_units, base_price, price
         FROM price_snapshots
        WHERE ts > now() - ($1 || ' hours')::interval
        ORDER BY ts ASC`,
      [String(hours)]
    );
    return rows;
  }
}

module.exports = new PricingEngine();
