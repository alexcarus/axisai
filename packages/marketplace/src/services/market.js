"use strict";

const { randomUUID } = require("crypto");
const { ethers } = require("ethers");
const { pool } = require("../db/pool");
const redis = require("../redis");
const config = require("../config");
const escrowChain = require("../chain/escrow");

/**
 * AXIS Market — AI-quoted trading with live settlement.
 *
 * A trader requests a quote; the engine prices it with an AI-tightened spread
 * and a protocol fee that splits between the liquidity pool and the AXIS AI
 * miners. Quotes live in Redis with a short TTL; accepting one settles into the
 * persistent `market_fills` ledger and credits the split. The mid price is kept
 * in Redis and drifts with order flow so the book is shared across all traders.
 */

const M = config.market;
const MID_KEY = "mkt:mid";
const QUOTE_PREFIX = "mkt:quote:";

async function getMid() {
  const v = await redis.get(MID_KEY);
  if (v) return Number.parseFloat(v);
  await redis.set(MID_KEY, String(M.basePrice));
  return M.basePrice;
}

async function nudgeMid(side, amount) {
  // Market impact: buys lift the mid, sells press it; size-scaled, plus noise.
  const mid = await getMid();
  const impact =
    (side === "buy" ? 1 : -1) * Math.min(0.0008, amount / 5_000_000);
  const drift = (Math.random() - 0.5) * 0.0006;
  const next = Math.max(0.0001, mid * (1 + impact + drift));
  await redis.set(MID_KEY, String(next));
  return next;
}

function priceFor(side, mid) {
  const half = (mid * M.aiSpread) / 2;
  return side === "buy" ? mid + half : mid - half;
}

/** Builds and stores an AI quote. */
async function quote({ side, asset = "AXIS", amount, trader, miner } = {}) {
  const s = side === "sell" ? "sell" : "buy";
  const amt = Math.max(0, Number(amount) || 0);
  if (!amt) {
    const e = new Error("amount must be greater than 0");
    e.status = 400;
    throw e;
  }
  const mid = await getMid();
  const price = priceFor(s, mid);
  const notional = amt * price;
  const fee = notional * M.feeRate;
  const lpFee = fee * M.lpShare;
  const minerFee = fee * M.minerShare;
  const burnFee = fee * M.burnShare; // routed to buyback-and-burn
  const buybackAxis = price > 0 ? burnFee / price : 0; // AXIS bought at mid + burned
  const aiSaved = (amt * mid * (M.baseSpread - M.aiSpread)) / 2;
  const id = randomUUID();
  const q = {
    quote_id: id,
    side: s,
    asset,
    amount: amt,
    price,
    notional,
    fee,
    split: { liquidity: lpFee, miner: minerFee, burn: burnFee },
    buyback_axis: buybackAxis,
    ai_saved: aiSaved,
    trader: trader || null,
    miner: miner || M.minerWallet,
    expires_at: new Date(Date.now() + M.quoteTtlSeconds * 1000).toISOString(),
  };
  await redis.set(QUOTE_PREFIX + id, JSON.stringify(q), "EX", M.quoteTtlSeconds);
  return q;
}

/** Accepts a quote and settles it into the ledger (split credited). */
async function execute({ quote_id, trader, miner, pnl = 0 } = {}) {
  if (!quote_id) {
    const e = new Error("quote_id is required");
    e.status = 400;
    throw e;
  }
  const raw = await redis.get(QUOTE_PREFIX + quote_id);
  if (!raw) {
    const e = new Error("quote not found or expired");
    e.status = 404;
    throw e;
  }
  await redis.del(QUOTE_PREFIX + quote_id); // one-shot: a quote settles once
  const q = JSON.parse(raw);
  const minerWallet = miner || q.miner || M.minerWallet;
  const traderWallet = trader || q.trader || null;

  const burnFee = q.split.burn ?? 0;
  const buybackAxis = q.buyback_axis ?? (q.price > 0 ? burnFee / q.price : 0);
  const { rows } = await pool.query(
    `INSERT INTO market_fills
       (side, asset, amount, price, notional, fee, lp_fee, miner_fee, burn_fee, buyback_axis, ai_saved, trader_wallet, miner_wallet, pnl)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id, created_at`,
    [
      q.side,
      q.asset,
      q.amount,
      q.price,
      q.notional,
      q.fee,
      q.split.liquidity,
      q.split.miner,
      burnFee,
      buybackAxis,
      q.ai_saved,
      traderWallet,
      minerWallet,
      Number(pnl) || 0,
    ],
  );

  // Route the miner's fee share on-chain through escrow (when enabled): the
  // operator locks the miner's AXIS share and releases it to the miner wallet.
  let onchain = { onchain: false };
  if (config.chain.onchain) {
    const minerAxis = q.price > 0 ? q.split.miner / q.price : 0;
    if (minerAxis > 0) {
      onchain = await escrowChain.settleMinerShare(
        rows[0].id,
        minerWallet,
        ethers.parseEther(minerAxis.toFixed(18)),
      );
      if (onchain.onchain) {
        await pool.query(
          "UPDATE market_fills SET miner_axis = $1, settlement_tx = $2 WHERE id = $3",
          [onchain.miner_axis, onchain.release_tx, rows[0].id],
        );
      }
    }
  }

  const mid = await nudgeMid(q.side, q.amount);
  const stats = await statsInternal();
  return {
    fill_id: rows[0].id,
    settled_at: rows[0].created_at,
    side: q.side,
    asset: q.asset,
    amount: q.amount,
    price: q.price,
    notional: q.notional,
    fee: q.fee,
    split: { liquidity: q.split.liquidity, miner: q.split.miner, burn: burnFee },
    buyback_axis: buybackAxis,
    ai_saved: q.ai_saved,
    miner_wallet: minerWallet,
    onchain: onchain.onchain || false,
    settlement_tx: onchain.release_tx || null,
    miner_axis: onchain.miner_axis || null,
    mid,
    stats,
  };
}

async function statsInternal() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS fills,
            COALESCE(SUM(notional),0) AS volume,
            COALESCE(SUM(lp_fee),0)   AS liquidity_earnings,
            COALESCE(SUM(miner_fee),0) AS miner_earnings,
            COALESCE(SUM(burn_fee),0) AS buyback_usdc,
            COALESCE(SUM(buyback_axis),0) AS buyback_burned_axis,
            COALESCE(SUM(pnl),0)      AS trader_pnl
       FROM market_fills`,
  );
  const r = rows[0];
  return {
    fills: r.fills,
    volume_usdc: Number(r.volume),
    liquidity_earnings_usdc: Number(r.liquidity_earnings),
    miner_earnings_usdc: Number(r.miner_earnings),
    buyback_usdc: Number(r.buyback_usdc),
    buyback_burned_axis: Number(r.buyback_burned_axis),
    trader_pnl_usdc: Number(r.trader_pnl),
  };
}

async function stats() {
  const mid = await getMid();
  return { mid, ...(await statsInternal()) };
}

async function book(depth = 6) {
  const mid = await getMid();
  const bids = [];
  const asks = [];
  for (let i = 1; i <= depth; i++) {
    const off = mid * 0.0008 * i;
    bids.push({ price: mid - off, size: Math.round(200 + Math.random() * 1800) });
    asks.push({ price: mid + off, size: Math.round(200 + Math.random() * 1800) });
  }
  return {
    mid,
    bid: mid - (mid * M.aiSpread) / 2,
    ask: mid + (mid * M.aiSpread) / 2,
    bids,
    asks,
  };
}

async function recentFills(limit = 30) {
  const { rows } = await pool.query(
    `SELECT id, side, amount, price, notional, miner_fee, lp_fee, pnl, miner_wallet, created_at
       FROM market_fills ORDER BY created_at DESC LIMIT $1`,
    [Math.min(100, Math.max(1, limit))],
  );
  return rows.map((r) => ({
    id: r.id,
    side: r.side,
    amount: Number(r.amount),
    price: Number(r.price),
    notional: Number(r.notional),
    miner_fee: Number(r.miner_fee),
    lp_fee: Number(r.lp_fee),
    pnl: Number(r.pnl),
    miner_wallet: r.miner_wallet,
    ts: r.created_at,
  }));
}

module.exports = { quote, execute, stats, book, recentFills, getMid };
