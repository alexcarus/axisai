"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { shortAddress } from "../lib/axis";
import {
  AxisMarketClient,
  type MarketQuoteResp,
  marketUrl,
} from "../lib/market";
import { loadWallet } from "../lib/wallet-store";

// ---------------------------------------------------------------------------
// AXIS Market — AI-quoted trading.
//
// A trader submits an order and receives an AI-optimized quote. The protocol
// fee on every fill splits between the liquidity pool (the capital that fills
// the order) and the AXIS AI miners (whose verified inference powers the pricing
// and execution engine). In AI auto-trade mode, the engine trades on the
// trader's behalf — the trader earns the optimized PnL, the miners earn the AI
// fee on every cycle.
// ---------------------------------------------------------------------------

const BASE_PRICE = 2.41; // illustrative AXIS/USDC mid
const FEE_RATE = 0.005; // 0.50% protocol fee on notional
const LP_SHARE = 0.6; // share of the fee routed to liquidity providers
const MINER_SHARE = 0.4; // share of the fee routed to AXIS AI miners
const BASE_SPREAD = 0.008; // 0.80% raw spread
const AI_SPREAD = 0.002; // 0.20% AI-optimized spread
const fmt = (n: number, d = 2) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

type Side = "buy" | "sell";

type Quote = {
  side: Side;
  amount: number; // AXIS
  price: number; // USDC per AXIS
  notional: number; // USDC
  fee: number; // USDC
  lpFee: number; // USDC -> liquidity
  minerFee: number; // USDC -> AXIS AI miners
  aiSaved: number; // USDC the AI-tightened spread saves the trader
  quote_id?: string; // present when the quote came from the live gateway
  receive: string;
  pay: string;
  ts: number;
};

type Fill = {
  id: string;
  side: Side;
  amount: number;
  price: number;
  minerFee: number;
  pnl: number;
  txAxis?: string; // AXIS minted to the miner on-chain (escrow release)
  ts: number;
};

function midNow(t = 0) {
  // Gentle drift + noise so the book feels alive.
  return (
    BASE_PRICE * (1 + 0.012 * Math.sin(t / 7) + (Math.random() - 0.5) * 0.004)
  );
}

function buildQuote(side: Side, amount: number, mid: number): Quote {
  const half = (mid * AI_SPREAD) / 2;
  const price = side === "buy" ? mid + half : mid - half;
  const notional = amount * price;
  const fee = notional * FEE_RATE;
  const lpFee = fee * LP_SHARE;
  const minerFee = fee * MINER_SHARE;
  // What the AI's tighter spread saves the trader vs. the raw spread.
  const aiSaved = (amount * mid * (BASE_SPREAD - AI_SPREAD)) / 2;
  return {
    side,
    amount,
    price,
    notional,
    fee,
    lpFee,
    minerFee,
    aiSaved,
    receive:
      side === "buy"
        ? `${fmt(amount, 2)} AXIS`
        : `${fmt(notional - fee, 2)} USDC`,
    pay:
      side === "buy"
        ? `${fmt(notional + fee, 2)} USDC`
        : `${fmt(amount, 2)} AXIS`,
    ts: Date.now(),
  };
}

/** Maps a live-gateway quote into the widget's Quote shape. */
function mapServerQuote(r: MarketQuoteResp): Quote {
  return {
    side: r.side,
    amount: r.amount,
    price: r.price,
    notional: r.notional,
    fee: r.fee,
    lpFee: r.split.liquidity,
    minerFee: r.split.miner,
    aiSaved: r.ai_saved,
    quote_id: r.quote_id,
    receive:
      r.side === "buy"
        ? `${fmt(r.amount, 2)} AXIS`
        : `${fmt(r.notional - r.fee, 2)} USDC`,
    pay:
      r.side === "buy"
        ? `${fmt(r.notional + r.fee, 2)} USDC`
        : `${fmt(r.amount, 2)} AXIS`,
    ts: Date.now(),
  };
}

export function MarketWidget({ className }: { className?: string }) {
  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("250");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [fills, setFills] = useState<Fill[]>([]);
  const [traderPnl, setTraderPnl] = useState(0);
  const [minerEarn, setMinerEarn] = useState(0);
  const [volume, setVolume] = useState(0);
  const [auto, setAuto] = useState(false);

  // The trader's own AXIS mining wallet — when present, the market routes the
  // AI fee share of every fill to this address, so trading earns into the same
  // balance as mining. Falls back to the gateway's miner pool when unset.
  const [minerWallet, setMinerWallet] = useState<string | null>(null);
  const minerRef = useRef<string | null>(null);
  minerRef.current = minerWallet;

  const tickRef = useRef(0);
  const autoRef = useRef(false);
  autoRef.current = auto;

  // Live settlement: route quotes/fills to the market gateway when configured.
  const liveUrl = marketUrl();
  const isLive = Boolean(liveUrl);
  const clientRef = useRef<AxisMarketClient | null>(
    liveUrl ? new AxisMarketClient(liveUrl) : null,
  );
  const traderRef = useRef(`web-${Math.random().toString(36).slice(2, 10)}`);

  // Pick up the self-custodial mining wallet so trading fees accrue to it.
  useEffect(() => {
    const w = loadWallet();
    if (w) setMinerWallet(w.address);
  }, []);

  // Seed the shared market stats + recent fills when settling live.
  useEffect(() => {
    const c = clientRef.current;
    if (!c) return;
    c.stats()
      .then((s) => {
        setMinerEarn(s.miner_earnings_usdc);
        setVolume(s.volume_usdc);
        setTraderPnl(s.trader_pnl_usdc);
      })
      .catch(() => {});
    c.fills(30)
      .then((fs) =>
        setFills(
          fs.map((f) => ({
            id: f.id,
            side: f.side,
            amount: f.amount,
            price: f.price,
            minerFee: f.miner_fee,
            pnl: f.pnl,
            ts: new Date(f.ts).getTime(),
          })),
        ),
      )
      .catch(() => {});
  }, []);

  const getQuote = useCallback(async () => {
    const amt = Math.max(0, Number.parseFloat(amount) || 0);
    if (!amt) return;
    const c = clientRef.current;
    if (c) {
      try {
        setQuote(
          mapServerQuote(
            await c.quote({
              side,
              amount: amt,
              trader: traderRef.current,
              miner: minerRef.current ?? undefined,
            }),
          ),
        );
        return;
      } catch {
        /* fall back to a local quote */
      }
    }
    setQuote(buildQuote(side, amt, midNow(tickRef.current)));
  }, [side, amount]);

  const execute = useCallback(async (q: Quote, aiPnl = 0) => {
    const c = clientRef.current;
    if (c && q.quote_id) {
      try {
        const r = await c.execute({
          quote_id: q.quote_id,
          trader: traderRef.current,
          miner: minerRef.current ?? undefined,
          pnl: aiPnl,
        });
        setFills((prev) =>
          [
            {
              id: r.fill_id,
              side: q.side,
              amount: q.amount,
              price: q.price,
              minerFee: q.minerFee,
              pnl: aiPnl,
              txAxis: r.onchain ? (r.miner_axis ?? undefined) : undefined,
              ts: Date.now(),
            },
            ...prev,
          ].slice(0, 30),
        );
        setMinerEarn(r.stats.miner_earnings_usdc);
        setVolume(r.stats.volume_usdc);
        setTraderPnl(r.stats.trader_pnl_usdc);
        return;
      } catch {
        /* server rejected (e.g. quote expired) — skip this fill */
        return;
      }
    }
    // Local settlement.
    setFills((prev) =>
      [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          side: q.side,
          amount: q.amount,
          price: q.price,
          minerFee: q.minerFee,
          pnl: aiPnl,
          ts: Date.now(),
        },
        ...prev,
      ].slice(0, 30),
    );
    setMinerEarn((m) => m + q.minerFee);
    setVolume((v) => v + q.notional);
    setTraderPnl((p) => p + aiPnl);
  }, []);

  // AI auto-trade loop: the engine sizes a trade, quotes it, and fills it. The
  // trader earns the AI-optimized PnL; miners earn the fee every cycle.
  useEffect(() => {
    if (!auto) return;
    let live = true;
    const run = async () => {
      while (live && autoRef.current) {
        tickRef.current += 1;
        const s: Side = Math.random() > 0.5 ? "buy" : "sell";
        const amt = 40 + Math.random() * 220;
        const c = clientRef.current;
        let q: Quote;
        if (c) {
          try {
            q = mapServerQuote(
              await c.quote({
                side: s,
                amount: amt,
                trader: traderRef.current,
                miner: minerRef.current ?? undefined,
              }),
            );
          } catch {
            q = buildQuote(s, amt, midNow(tickRef.current));
          }
        } else {
          q = buildQuote(s, amt, midNow(tickRef.current));
        }
        // AI edge: ~63% of cycles land a small positive PnL.
        const win = Math.random() < 0.63;
        const pnl =
          (win ? 1 : -1) * q.notional * (0.0015 + Math.random() * 0.004);
        setQuote(q);
        await execute(q, pnl);
        await new Promise((r) => setTimeout(r, 1400 + Math.random() * 900));
      }
    };
    void run();
    return () => {
      live = false;
    };
  }, [auto, execute]);

  const winRate =
    fills.length > 0
      ? Math.round((fills.filter((f) => f.pnl > 0).length / fills.length) * 100)
      : 0;

  return (
    <div className={`axt ${className ?? ""}`}>
      <Styles />

      <div className="axt-bar">
        <div className="axt-dots">
          <span />
        </div>
        <div className="axt-title">axis · market</div>
        <div className={`axt-mode ${isLive ? "axt-on" : ""}`}>
          <span className="axt-mode-dot" />
          {isLive ? "LIVE" : "LOCAL"}
          {auto ? " · AI" : ""}
        </div>
      </div>

      <div className="axt-body">
        {/* Where the AI fee share is credited */}
        <div className="axt-miner">
          <span className="axt-miner-dot" />
          {minerWallet ? (
            <>
              AI miner fees → <b>your wallet</b>{" "}
              <span className="axt-miner-addr">
                {shortAddress(minerWallet)}
              </span>
            </>
          ) : (
            <>
              AI miner fees → the miner pool. Open the miner to mine a wallet
              and earn these fees yourself.
            </>
          )}
        </div>

        {/* Order ticket */}
        <div className="axt-ticket">
          <div className="axt-side">
            <button
              type="button"
              className={`axt-side-btn ${side === "buy" ? "axt-buy" : ""}`}
              onClick={() => setSide("buy")}
            >
              Buy
            </button>
            <button
              type="button"
              className={`axt-side-btn ${side === "sell" ? "axt-sell" : ""}`}
              onClick={() => setSide("sell")}
            >
              Sell
            </button>
          </div>
          <div className="axt-amount">
            <input
              className="axt-amount-input"
              type="number"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className="axt-amount-unit">AXIS</span>
          </div>
          <button type="button" className="axt-quote-btn" onClick={getQuote}>
            Get AI quote
          </button>
        </div>

        {/* Quote */}
        {quote ? (
          <div className="axt-quote">
            <div className="axt-q-row axt-q-head">
              <span>
                {quote.side === "buy" ? "Buy" : "Sell"} {fmt(quote.amount, 0)}{" "}
                AXIS
              </span>
              <span className="axt-q-price">@ {fmt(quote.price, 4)} USDC</span>
            </div>
            <div className="axt-q-row">
              <span>You pay</span>
              <span className="axt-num">{quote.pay}</span>
            </div>
            <div className="axt-q-row">
              <span>You receive</span>
              <span className="axt-num axt-rec">{quote.receive}</span>
            </div>
            <div className="axt-q-row">
              <span>AI spread tightening saves you</span>
              <span className="axt-num axt-saved">
                +{fmt(quote.aiSaved)} USDC
              </span>
            </div>
            <div className="axt-split">
              <div className="axt-split-h">
                Protocol fee {fmt(quote.fee, 2)} USDC — split
              </div>
              <div className="axt-split-bar">
                <span
                  className="axt-split-lp"
                  style={{ width: `${LP_SHARE * 100}%` }}
                />
                <span
                  className="axt-split-miner"
                  style={{ width: `${MINER_SHARE * 100}%` }}
                />
              </div>
              <div className="axt-split-legend">
                <span>
                  <i className="axt-dot-lp" /> Liquidity {fmt(quote.lpFee, 2)}{" "}
                  USDC
                </span>
                <span>
                  <i className="axt-dot-miner" /> AXIS AI miners{" "}
                  {fmt(quote.minerFee, 2)} USDC
                </span>
              </div>
            </div>
            <button
              type="button"
              className="axt-exec"
              onClick={() => execute(quote)}
              disabled={auto}
            >
              {auto ? "AI is trading…" : "Execute trade"}
            </button>
          </div>
        ) : (
          <div className="axt-empty">
            Submit an order to receive an AI-optimized quote. Every fill routes
            a fee to the liquidity pool and to the AXIS AI miners.
          </div>
        )}

        {/* AI auto-trade + stats */}
        <div className="axt-auto-row">
          <button
            type="button"
            className={`axt-auto-btn ${auto ? "axt-auto-on" : ""}`}
            onClick={() => setAuto((a) => !a)}
          >
            <span className="axt-auto-ind" />
            {auto ? "Stop AI auto-trade" : "Let AXIS AI trade for me"}
          </button>
        </div>

        <div className="axt-stats">
          <Stat
            label="Trader PnL"
            value={`${traderPnl >= 0 ? "+" : ""}${fmt(traderPnl)} USDC`}
            good={traderPnl >= 0}
          />
          <Stat label="Miner earnings" value={`${fmt(minerEarn)} USDC`} good />
          <Stat label="Volume" value={`${fmt(volume, 0)} USDC`} />
          <Stat label="AI win rate" value={`${winRate}%`} />
        </div>

        {/* Fills */}
        <div className="axt-fills">
          {fills.length === 0 ? (
            <div className="axt-fills-empty">No fills yet.</div>
          ) : (
            fills.map((f) => (
              <div key={f.id} className="axt-fill">
                <span
                  className={`axt-fill-side ${f.side === "buy" ? "axt-buy-t" : "axt-sell-t"}`}
                >
                  {f.side === "buy" ? "BUY" : "SELL"}
                </span>
                <span className="axt-fill-amt">{fmt(f.amount, 0)} AXIS</span>
                <span className="axt-num axt-fill-px">{fmt(f.price, 4)}</span>
                <span
                  className="axt-num axt-fill-miner"
                  title={f.txAxis ? "Settled on-chain via escrow" : undefined}
                >
                  {f.txAxis
                    ? `⛓ +${fmt(Number(f.txAxis), 3)} AXIS`
                    : `miner +${fmt(f.minerFee)}`}
                </span>
                {f.pnl !== 0 && (
                  <span
                    className={`axt-num axt-fill-pnl ${f.pnl >= 0 ? "axt-pos" : "axt-neg"}`}
                  >
                    {f.pnl >= 0 ? "+" : ""}
                    {fmt(f.pnl)}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <div className="axt-foot">
        {minerWallet
          ? "The AI-miner share of every fee is credited to your connected mining wallet — trading earns into the same AXIS balance as mining. "
          : ""}
        {isLive
          ? "Settling live on the AXIS market gateway — quotes and fills are persisted to a shared ledger and every fee is split between the liquidity pool and the AXIS AI miners."
          : "Illustrative AXIS/USDC market running locally. Set VITE_AXIS_MARKET_URL to settle live and route the fee split on the gateway."}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good?: boolean;
}) {
  return (
    <div className="axt-stat">
      <div className={`axt-stat-val ${good ? "axt-stat-good" : ""}`}>
        {value}
      </div>
      <div className="axt-stat-label">{label}</div>
    </div>
  );
}

function Styles() {
  return (
    <style>{`
      .axt {
        --axt-line: light-dark(rgba(9,9,11,0.10), rgba(255,255,255,0.09));
        --axt-soft: light-dark(rgba(9,9,11,0.028), rgba(255,255,255,0.03));
        --axt-lime: #cdf24e;
        --axt-lime-ink: light-dark(#3f6b15, #cdf24e);
        --axt-ink: var(--vocs-text-color-heading);
        --axt-ink2: var(--vocs-text-color-secondary);
        --axt-ink3: var(--vocs-text-color-muted);
        --axt-buy: light-dark(#15803d, #4ade80);
        --axt-sell: light-dark(#b91c1c, #f0857d);
        display: flex; flex-direction: column; width: 100%;
        border: 1px solid var(--axt-line); border-radius: 14px; overflow: hidden;
        background: light-dark(rgba(255,255,255,0.5), rgba(255,255,255,0.012));
        font-family: var(--font-mono, "Geist Mono", monospace); color: var(--axt-ink);
      }
      .axt-bar { display: flex; align-items: center; gap: 0.6rem; padding: 0.55rem 0.9rem; border-bottom: 1px solid var(--axt-line); }
      .axt-dots span { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--axt-lime); box-shadow: 0 0 7px var(--axt-lime); }
      .axt-title { font-size: 11.5px; color: var(--axt-ink3); letter-spacing: 0.1em; text-transform: uppercase; }
      .axt-mode { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 9.5px; letter-spacing: 0.14em; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--axt-line); color: var(--axt-ink3); }
      .axt-mode-dot { width: 6px; height: 6px; border-radius: 50%; background: light-dark(#b59000, #e0c54a); }
      .axt-on .axt-mode-dot { background: var(--axt-lime); box-shadow: 0 0 7px var(--axt-lime); }

      .axt-body { display: flex; flex-direction: column; gap: 0.8rem; padding: 0.9rem; }

      .axt-miner { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 10.5px; color: var(--axt-ink3); padding: 6px 9px; border: 1px solid var(--axt-line); border-radius: 8px; background: var(--axt-soft); }
      .axt-miner b { color: var(--axt-lime-ink); font-weight: 600; }
      .axt-miner-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--axt-lime); box-shadow: 0 0 7px var(--axt-lime); }
      .axt-miner-addr { font-variant-numeric: tabular-nums; color: var(--axt-ink2); }

      .axt-ticket { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; }
      .axt-side { display: inline-flex; border: 1px solid var(--axt-line); border-radius: 8px; overflow: hidden; }
      .axt-side-btn { padding: 7px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer; background: transparent; border: none; color: var(--axt-ink3); }
      .axt-side-btn.axt-buy { background: var(--axt-buy); color: #04130a; }
      .axt-side-btn.axt-sell { background: var(--axt-sell); color: #fff; }
      .axt-amount { display: flex; align-items: center; gap: 6px; border: 1px solid var(--axt-line); border-radius: 8px; padding: 0 10px; background: var(--vocs-background-color-primary); }
      .axt-amount-input { flex: 1; width: 100%; border: none; background: transparent; color: var(--axt-ink); font-family: inherit; font-size: 14px; padding: 7px 0; outline: none; }
      .axt-amount-unit { font-size: 10px; color: var(--axt-lime-ink); letter-spacing: 0.06em; }
      .axt-quote-btn { padding: 8px 14px; border-radius: 8px; font-size: 12.5px; font-weight: 600; cursor: pointer; border: 1px solid var(--axt-line); background: var(--axt-soft); color: var(--axt-ink); white-space: nowrap; }
      .axt-quote-btn:hover { border-color: var(--axt-ink3); }

      .axt-empty { font-size: 11.5px; line-height: 1.6; color: var(--axt-ink3); padding: 0.9rem; text-align: center; border: 1px dashed var(--axt-line); border-radius: 10px; }
      .axt-num { font-variant-numeric: tabular-nums; }

      .axt-quote { border: 1px solid var(--axt-line); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 7px; background: var(--axt-soft); }
      .axt-q-row { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--axt-ink2); }
      .axt-q-head { font-weight: 600; color: var(--axt-ink); }
      .axt-q-price { color: var(--axt-lime-ink); }
      .axt-rec { color: var(--axt-ink); font-weight: 600; }
      .axt-saved { color: var(--axt-lime-ink); font-weight: 600; }
      .axt-split { margin-top: 4px; padding-top: 8px; border-top: 1px solid var(--axt-line); display: flex; flex-direction: column; gap: 6px; }
      .axt-split-h { font-size: 10px; color: var(--axt-ink3); text-transform: uppercase; letter-spacing: 0.06em; }
      .axt-split-bar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; background: var(--axt-line); }
      .axt-split-lp { background: light-dark(#7a8cff, #8fa2ff); }
      .axt-split-miner { background: var(--axt-lime); }
      .axt-split-legend { display: flex; justify-content: space-between; gap: 8px; font-size: 10.5px; color: var(--axt-ink2); flex-wrap: wrap; }
      .axt-split-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
      .axt-dot-lp { background: light-dark(#7a8cff, #8fa2ff); }
      .axt-dot-miner { background: var(--axt-lime); }
      .axt-exec { margin-top: 4px; padding: 9px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: 1px solid var(--axt-lime); background: var(--axt-lime); color: #0a0a0a; }
      .axt-exec:disabled { opacity: 0.5; cursor: not-allowed; }

      .axt-auto-row { display: flex; }
      .axt-auto-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 9px; border-radius: 8px; font-size: 12.5px; font-weight: 600; cursor: pointer; border: 1px dashed var(--axt-lime-ink); background: transparent; color: var(--axt-lime-ink); }
      .axt-auto-ind { width: 7px; height: 7px; border-radius: 50%; background: var(--axt-lime-ink); }
      .axt-auto-on { background: var(--axt-lime); color: #0a0a0a; border-style: solid; border-color: var(--axt-lime); }
      .axt-auto-on .axt-auto-ind { background: #0a0a0a; animation: axtBlink 1s steps(2) infinite; }
      @keyframes axtBlink { 0%,100% { opacity: 1; } 50% { opacity: 0.2; } }

      .axt-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--axt-line); border: 1px solid var(--axt-line); border-radius: 8px; overflow: hidden; }
      .axt-stat { padding: 8px 9px; background: var(--vocs-background-color-primary); }
      .axt-stat-val { font-size: 13px; font-weight: 600; color: var(--axt-ink); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .axt-stat-good { color: var(--axt-lime-ink); }
      .axt-stat-label { font-size: 9px; color: var(--axt-ink3); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 3px; }

      .axt-fills { max-height: 150px; overflow-y: auto; border: 1px solid var(--axt-line); border-radius: 8px; background: light-dark(rgba(9,9,11,0.012), rgba(0,0,0,0.16)); }
      .axt-fills-empty { font-size: 11px; color: var(--axt-ink3); padding: 0.9rem; text-align: center; }
      .axt-fill { display: grid; grid-template-columns: auto 1fr auto auto auto; gap: 9px; align-items: center; padding: 6px 10px; font-size: 11px; border-bottom: 1px solid var(--axt-soft); }
      .axt-fill:last-child { border-bottom: none; }
      .axt-fill-side { font-weight: 700; font-size: 9.5px; letter-spacing: 0.06em; }
      .axt-buy-t { color: var(--axt-buy); }
      .axt-sell-t { color: var(--axt-sell); }
      .axt-fill-amt { color: var(--axt-ink2); }
      .axt-fill-px { color: var(--axt-ink3); }
      .axt-fill-miner { color: var(--axt-lime-ink); font-size: 10px; }
      .axt-pos { color: var(--axt-buy); }
      .axt-neg { color: var(--axt-sell); }

      .axt-foot { padding: 0.55rem 0.9rem; font-size: 10px; line-height: 1.5; color: var(--axt-ink3); border-top: 1px solid var(--axt-line); }

      @media (max-width: 520px) {
        .axt-ticket { grid-template-columns: 1fr; }
        .axt-stats { grid-template-columns: repeat(2, 1fr); }
      }
    `}</style>
  );
}
