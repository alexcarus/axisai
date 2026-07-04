"use client";

import { useCallback, useEffect, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { shortAddress } from "../lib/axis";
import {
  type Balances,
  connectWallet,
  currentAccount,
  ensureAllowances,
  getBalances,
  getSpotEth,
  getSpotPrice,
  hasWallet,
  injected,
  inputTokenFor,
  publicClient,
  quoteExactIn,
  type Side,
  swapExactIn,
} from "../lib/uniswap-v4";

// ---------------------------------------------------------------------------
// AXIS Market — REAL on-chain trading against the Uniswap v4 ETH/AXIS pool.
//
// Connect an injected wallet (MetaMask / Coinbase Wallet), get a live quote
// from the v4 Quoter, and swap real ETH ↔ AXIS through the Universal Router.
// No simulation: every trade settles on Base and moves the real pool price.
// ---------------------------------------------------------------------------

const POOL_FEE = 0.01; // 1% pool fee (to liquidity providers)
const SLIPPAGE_OPTS = [50, 100, 300]; // basis points: 0.5% / 1% / 3%
const IDLE_MS = 15 * 60 * 1000; // auto-disconnect the wallet after 15 min idle

const fmt = (n: number, d = 2) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

const UNISWAP_POOL_URL =
  "https://app.uniswap.org/explore/pools/base/0x4425a476a588b210c430062cfa30a7adc26fae4dbb1ddb2b8db488bbde16255a";

type SwapRow = {
  hash: string;
  side: Side;
  pay: string;
  receive: string;
  ts: number;
};

export function MarketWidget({ className }: { className?: string }) {
  const [account, setAccount] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [balances, setBalances] = useState<Balances | null>(null);

  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("0.01");
  const [slippageBps, setSlippageBps] = useState(100);

  const [spot, setSpot] = useState<number | null>(null); // USD per AXIS
  const [spotEth, setSpotEth] = useState<number | null>(null); // ETH per AXIS
  const [quoteOut, setQuoteOut] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [swaps, setSwaps] = useState<SwapRow[]>([]);
  const [idleLoggedOut, setIdleLoggedOut] = useState(false);

  const walletPresent = hasWallet();

  // buy: pay ETH → receive AXIS; sell: pay AXIS → receive ETH. Both are 18dp.
  const decIn = 18;
  const decOut = 18;
  const unitIn = side === "buy" ? "ETH" : "AXIS";
  const unitOut = side === "buy" ? "AXIS" : "ETH";
  // Decimals to show for each token in the UI.
  const dpIn = side === "buy" ? 5 : 2; // ETH small, AXIS whole-ish
  const dpOut = side === "buy" ? 2 : 5;

  const refreshBalances = useCallback(async (addr: string) => {
    try {
      setBalances(await getBalances(addr));
    } catch {
      /* RPC hiccup — leave stale balances */
    }
  }, []);

  const refreshSpot = useCallback(async () => {
    try {
      const [usd, eth] = await Promise.all([getSpotPrice(), getSpotEth()]);
      setSpot(usd);
      setSpotEth(eth);
    } catch {
      /* ignore */
    }
  }, []);

  // Live price on mount + a gentle refresh, and silently pick up an already-
  // connected wallet.
  useEffect(() => {
    void refreshSpot();
    const id = setInterval(refreshSpot, 20_000);
    void currentAccount().then((a) => {
      if (a) {
        setAccount(a);
        void refreshBalances(a);
      }
    });
    return () => clearInterval(id);
  }, [refreshSpot, refreshBalances]);

  // React to wallet account changes.
  useEffect(() => {
    const eth = injected();
    if (!eth?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accs = args[0];
      const a = Array.isArray(accs) && accs[0] ? String(accs[0]) : null;
      setAccount(a);
      setBalances(null);
      if (a) void refreshBalances(a);
    };
    eth.on("accountsChanged", onAccounts);
    return () => eth.removeListener?.("accountsChanged", onAccounts);
  }, [refreshBalances]);

  const parseAmountIn = useCallback((): bigint | null => {
    try {
      const raw = parseUnits((amount || "0").trim(), decIn);
      return raw > 0n ? raw : null;
    } catch {
      return null;
    }
  }, [amount, decIn]);

  // Debounced live quote whenever side / amount changes.
  useEffect(() => {
    setQuoteErr(null);
    const raw = parseAmountIn();
    if (!raw) {
      setQuoteOut(null);
      return;
    }
    let alive = true;
    setQuoting(true);
    const t = setTimeout(async () => {
      try {
        const out = await quoteExactIn(side, raw);
        if (alive) setQuoteOut(out);
      } catch {
        if (alive) {
          setQuoteOut(null);
          setQuoteErr("No quote — amount may exceed pool liquidity.");
        }
      } finally {
        if (alive) setQuoting(false);
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [side, parseAmountIn]);

  const amountInNum = Number.parseFloat(amount) || 0;
  const outNum = quoteOut ? Number(formatUnits(quoteOut, decOut)) : 0;
  // Effective price in ETH per AXIS (already includes the 1% fee + impact).
  const effPrice =
    side === "buy"
      ? outNum > 0
        ? amountInNum / outNum
        : 0
      : amountInNum > 0
        ? outNum / amountInNum
        : 0;
  const impactPct =
    spotEth && effPrice > 0 ? Math.abs((effPrice - spotEth) / spotEth) * 100 : 0;
  // USD per AXIS for display (ETH price × ETH/USD).
  const ethUsd = spot && spotEth ? spot / spotEth : 0;
  const effPriceUsd = effPrice * ethUsd;
  const minOut = quoteOut
    ? (quoteOut * BigInt(10_000 - slippageBps)) / 10_000n
    : 0n;
  const minOutNum = Number(formatUnits(minOut, decOut));

  const balIn =
    balances == null
      ? null
      : side === "buy"
        ? Number(formatUnits(balances.ethRaw, 18))
        : Number(formatUnits(balances.axisRaw, 18));
  const insufficient = balIn != null && amountInNum > balIn + 1e-9;
  const noGas = balances != null && balances.ethRaw === 0n;

  const onConnect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const a = await connectWallet();
      setAccount(a);
      setIdleLoggedOut(false);
      await refreshBalances(a);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? "Failed to connect wallet.");
    } finally {
      setConnecting(false);
    }
  }, [refreshBalances]);

  // Disconnect the wallet from the dapp (manual button or idle timeout). Also
  // revokes the connection so the wallet can't silently re-attach next load.
  const disconnect = useCallback(async (idle: boolean) => {
    setAccount(null);
    setBalances(null);
    setQuoteOut(null);
    setStatus(null);
    setError(null);
    setIdleLoggedOut(idle);
    try {
      await injected()?.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      /* wallet doesn't support revoke — clearing local state still logs out */
    }
  }, []);

  // Security: auto-disconnect after IDLE_MS with no activity (e.g. a shared or
  // unattended computer). Any mouse/key/touch/scroll or tab focus resets it.
  useEffect(() => {
    if (!account) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void disconnect(true), IDLE_MS);
    };
    const events = [
      "mousemove",
      "mousedown",
      "keydown",
      "touchstart",
      "scroll",
      "wheel",
    ];
    for (const ev of events)
      window.addEventListener(ev, reset, { passive: true });
    document.addEventListener("visibilitychange", reset);
    reset();
    return () => {
      clearTimeout(timer);
      for (const ev of events) window.removeEventListener(ev, reset);
      document.removeEventListener("visibilitychange", reset);
    };
  }, [account, disconnect]);

  const onSwap = useCallback(async () => {
    setError(null);
    if (!account) {
      void onConnect();
      return;
    }
    const raw = parseAmountIn();
    if (!raw) {
      setError("Enter an amount.");
      return;
    }
    setBusy(true);
    try {
      setStatus("Fetching latest quote…");
      const out = await quoteExactIn(side, raw);
      const min = (out * BigInt(10_000 - slippageBps)) / 10_000n;
      if (min <= 0n) throw new Error("Quote too small.");

      await ensureAllowances(account, inputTokenFor(side), raw, setStatus);

      setStatus("Swapping — confirm in your wallet…");
      const hash = await swapExactIn(account, side, raw, min);
      setStatus("Submitted — waiting for confirmation…");
      const rcpt = await publicClient.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success") throw new Error("Swap reverted on-chain.");

      const recvNum = Number(formatUnits(out, decOut));
      setSwaps((prev) =>
        [
          {
            hash,
            side,
            pay: `${fmt(amountInNum, side === "buy" ? 5 : 2)} ${unitIn}`,
            receive: `${fmt(recvNum, side === "buy" ? 2 : 5)} ${unitOut}`,
            ts: Date.now(),
          },
          ...prev,
        ].slice(0, 12),
      );
      setStatus("✓ Swap confirmed");
      await Promise.all([refreshBalances(account), refreshSpot()]);
      setTimeout(() => setStatus(null), 4000);
    } catch (e: unknown) {
      const msg = e as { shortMessage?: string; message?: string };
      const text = msg.shortMessage || msg.message || "Swap failed.";
      setError(
        /user rejected|denied/i.test(text)
          ? "Transaction rejected in wallet."
          : text.slice(0, 160),
      );
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, [
    account,
    side,
    slippageBps,
    amountInNum,
    unitIn,
    unitOut,
    decOut,
    onConnect,
    parseAmountIn,
    refreshBalances,
    refreshSpot,
  ]);

  const execLabel = !account
    ? "Connect wallet"
    : side === "buy"
      ? "Buy AXIS"
      : "Sell AXIS";

  return (
    <div className={`axt ${className ?? ""}`}>
      <Styles />

      <div className="axt-bar">
        <div className="axt-dots">
          <span />
        </div>
        <div className="axt-title">axis · market</div>
        <div className="axt-mode axt-on">
          <span className="axt-mode-dot" />
          LIVE · UNISWAP v4
        </div>
      </div>

      <div className="axt-body">
        {/* Live pool price */}
        <div className="axt-price">
          <span className="axt-price-dot" />
          <span>
            1 AXIS = <b>{spot != null ? `$${spot.toFixed(6)}` : "…"}</b>
          </span>
          <a
            className="axt-link"
            href={UNISWAP_POOL_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            pool ↗
          </a>
        </div>

        {/* Wallet */}
        {account ? (
          <div className="axt-wallet">
            <span className="axt-acct">
              <span className="axt-acct-dot" />
              {shortAddress(account)}
            </span>
            <span className="axt-wallet-right">
              <span className="axt-bals">
                {balances ? (
                  <>
                    <span>
                      {fmt(Number(formatUnits(balances.axisRaw, 18)), 2)} AXIS
                    </span>
                    <span>
                      {fmt(Number(formatUnits(balances.ethRaw, 18)), 5)} ETH
                    </span>
                  </>
                ) : (
                  <span>loading…</span>
                )}
              </span>
              <button
                type="button"
                className="axt-disconnect"
                onClick={() => void disconnect(false)}
                title="Disconnect wallet"
              >
                Disconnect
              </button>
            </span>
          </div>
        ) : (
          <>
            {idleLoggedOut && (
              <div className="axt-idle-note">
                🔒 Disconnected after 15 min of inactivity — reconnect to trade.
              </div>
            )}
            <button
              type="button"
              className="axt-connect"
              onClick={onConnect}
              disabled={connecting || !walletPresent}
            >
              {!walletPresent
                ? "No wallet detected — install MetaMask"
                : connecting
                  ? "Connecting…"
                  : "Connect wallet to trade"}
            </button>
          </>
        )}

        {/* Order ticket */}
        <div className="axt-ticket">
          <div className="axt-side">
            <button
              type="button"
              className={`axt-side-btn ${side === "buy" ? "axt-buy" : ""}`}
              onClick={() => {
                setSide("buy");
                setAmount("0.01");
              }}
            >
              Buy
            </button>
            <button
              type="button"
              className={`axt-side-btn ${side === "sell" ? "axt-sell" : ""}`}
              onClick={() => {
                setSide("sell");
                setAmount("1000");
              }}
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
              placeholder="0.0"
            />
            <span className="axt-amount-unit">{unitIn}</span>
          </div>
        </div>

        {/* Slippage */}
        <div className="axt-slip">
          <span className="axt-slip-label">Max slippage</span>
          {SLIPPAGE_OPTS.map((bps) => (
            <button
              key={bps}
              type="button"
              className={`axt-slip-btn ${slippageBps === bps ? "axt-slip-on" : ""}`}
              onClick={() => setSlippageBps(bps)}
            >
              {bps / 100}%
            </button>
          ))}
        </div>

        {/* Quote */}
        {quoteOut && amountInNum > 0 ? (
          <div className="axt-quote">
            <div className="axt-q-row axt-q-head">
              <span>
                {side === "buy" ? "Buy" : "Sell"} {unitOut}
              </span>
              <span className="axt-q-price">
                @ {effPriceUsd > 0 ? `$${fmt(effPriceUsd, 6)}` : "…"}/AXIS
              </span>
            </div>
            <div className="axt-q-row">
              <span>You pay</span>
              <span className="axt-num">
                {fmt(amountInNum, dpIn)} {unitIn}
              </span>
            </div>
            <div className="axt-q-row">
              <span>You receive (est.)</span>
              <span className="axt-num axt-rec">
                {fmt(outNum, dpOut)} {unitOut}
              </span>
            </div>
            <div className="axt-q-row">
              <span>Min received ({slippageBps / 100}% slippage)</span>
              <span className="axt-num">
                {fmt(minOutNum, dpOut)} {unitOut}
              </span>
            </div>
            <div className="axt-q-row axt-q-sub">
              <span>Price impact incl. fee</span>
              <span className="axt-num">{fmt(impactPct, 2)}%</span>
            </div>
            <div className="axt-q-row axt-q-sub">
              <span>Pool fee (to liquidity)</span>
              <span className="axt-num">{POOL_FEE * 100}%</span>
            </div>
          </div>
        ) : (
          <div className="axt-empty">
            {quoting
              ? "Fetching live quote from the pool…"
              : quoteErr
                ? quoteErr
                : "Enter an amount for a live on-chain quote against the ETH/AXIS pool."}
          </div>
        )}

        {/* Execute */}
        <button
          type="button"
          className="axt-exec"
          onClick={onSwap}
          disabled={
            busy ||
            (!!account && (!quoteOut || amountInNum <= 0 || insufficient))
          }
        >
          {busy
            ? "Working…"
            : insufficient
              ? `Insufficient ${unitIn}`
              : execLabel}
        </button>

        {noGas && account && (
          <div className="axt-warn">
            ⚠ This wallet has 0 ETH on Base — you need a little ETH for gas to
            swap.
          </div>
        )}
        {status && <div className="axt-status">{status}</div>}
        {error && <div className="axt-err">{error}</div>}

        {/* Recent swaps */}
        <div className="axt-fills">
          {swaps.length === 0 ? (
            <div className="axt-fills-empty">
              Your swaps this session will appear here.
            </div>
          ) : (
            swaps.map((s) => (
              <a
                key={s.hash}
                className="axt-fill"
                href={`https://basescan.org/tx/${s.hash}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span
                  className={`axt-fill-side ${s.side === "buy" ? "axt-buy-t" : "axt-sell-t"}`}
                >
                  {s.side === "buy" ? "BUY" : "SELL"}
                </span>
                <span className="axt-fill-amt">{s.pay}</span>
                <span className="axt-fill-arrow">→</span>
                <span className="axt-num axt-rec">{s.receive}</span>
                <span className="axt-fill-link">↗</span>
              </a>
            ))
          )}
        </div>
      </div>

      <div className="axt-foot">
        Real swaps on Base via the Uniswap v4 ETH/AXIS pool. Quotes are read
        live from the pool; trades are signed by your own wallet and settle
        on-chain. The 1% pool fee accrues to liquidity providers.
      </div>
    </div>
  );
}

function Styles() {
  return (
    <style>{`
      .axt {
        --axt-line: light-dark(rgba(9,9,11,0.10), rgba(255,255,255,0.09));
        --axt-soft: light-dark(rgba(9,9,11,0.028), rgba(255,255,255,0.03));
        --axt-lime: #eef2f9;
        --axt-lime-ink: light-dark(#1f9d63, #7fe0a8);
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
      .axt-dots span { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--axt-lime-ink); box-shadow: 0 0 7px var(--axt-lime-ink); }
      .axt-title { font-size: 11.5px; color: var(--axt-ink3); letter-spacing: 0.1em; text-transform: uppercase; }
      .axt-mode { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 9.5px; letter-spacing: 0.12em; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--axt-line); color: var(--axt-ink3); }
      .axt-mode-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--axt-lime-ink); box-shadow: 0 0 7px var(--axt-lime-ink); }

      .axt-body { display: flex; flex-direction: column; gap: 0.8rem; padding: 0.9rem; }

      .axt-price { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--axt-ink2); }
      .axt-price b { color: var(--axt-ink); font-variant-numeric: tabular-nums; }
      .axt-price-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--axt-lime-ink); box-shadow: 0 0 7px var(--axt-lime-ink); }
      .axt-link { margin-left: auto; font-size: 11px; color: var(--axt-lime-ink); text-decoration: none; }
      .axt-link:hover { text-decoration: underline; }

      .axt-wallet { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; border: 1px solid var(--axt-line); border-radius: 8px; background: var(--axt-soft); font-size: 11px; }
      .axt-acct { display: inline-flex; align-items: center; gap: 6px; color: var(--axt-ink2); font-variant-numeric: tabular-nums; }
      .axt-acct-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--axt-buy); }
      .axt-bals { display: inline-flex; gap: 10px; color: var(--axt-ink3); font-variant-numeric: tabular-nums; flex-wrap: wrap; justify-content: flex-end; }
      .axt-connect { padding: 10px; border-radius: 8px; font-size: 12.5px; font-weight: 600; cursor: pointer; border: 1px solid var(--axt-lime-ink); background: transparent; color: var(--axt-lime-ink); }
      .axt-connect:disabled { opacity: 0.55; cursor: not-allowed; }
      .axt-wallet-right { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
      .axt-disconnect { padding: 4px 9px; border-radius: 6px; font-size: 10px; cursor: pointer; border: 1px solid var(--axt-line); background: transparent; color: var(--axt-ink3); white-space: nowrap; }
      .axt-disconnect:hover { color: var(--axt-sell); border-color: var(--axt-sell); }
      .axt-idle-note { font-size: 10.5px; line-height: 1.4; color: light-dark(#92500a, #f0b15a); padding: 7px 9px; border: 1px solid var(--axt-line); border-radius: 8px; background: var(--axt-soft); }

      .axt-ticket { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: center; }
      .axt-side { display: inline-flex; border: 1px solid var(--axt-line); border-radius: 8px; overflow: hidden; }
      .axt-side-btn { padding: 7px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer; background: transparent; border: none; color: var(--axt-ink3); }
      .axt-side-btn.axt-buy { background: var(--axt-buy); color: #04130a; }
      .axt-side-btn.axt-sell { background: var(--axt-sell); color: #fff; }
      .axt-amount { display: flex; align-items: center; gap: 6px; border: 1px solid var(--axt-line); border-radius: 8px; padding: 0 10px; background: var(--vocs-background-color-primary); }
      .axt-amount-input { flex: 1; width: 100%; border: none; background: transparent; color: var(--axt-ink); font-family: inherit; font-size: 14px; padding: 7px 0; outline: none; }
      .axt-amount-unit { font-size: 10px; color: var(--axt-lime-ink); letter-spacing: 0.06em; }

      .axt-slip { display: flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--axt-ink3); }
      .axt-slip-label { margin-right: auto; text-transform: uppercase; letter-spacing: 0.06em; }
      .axt-slip-btn { padding: 4px 9px; border-radius: 6px; font-size: 11px; cursor: pointer; border: 1px solid var(--axt-line); background: transparent; color: var(--axt-ink2); font-family: inherit; }
      .axt-slip-on { background: var(--axt-lime); color: #0a0c10; border-color: var(--axt-lime); font-weight: 600; }

      .axt-empty { font-size: 11.5px; line-height: 1.6; color: var(--axt-ink3); padding: 0.9rem; text-align: center; border: 1px dashed var(--axt-line); border-radius: 10px; }
      .axt-num { font-variant-numeric: tabular-nums; }

      .axt-quote { border: 1px solid var(--axt-line); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 7px; background: var(--axt-soft); }
      .axt-q-row { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--axt-ink2); }
      .axt-q-head { font-weight: 600; color: var(--axt-ink); }
      .axt-q-price { color: var(--axt-lime-ink); }
      .axt-q-sub { font-size: 11px; color: var(--axt-ink3); }
      .axt-rec { color: var(--axt-ink); font-weight: 600; }

      .axt-exec { margin-top: 2px; padding: 11px; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; border: 1px solid var(--axt-lime); background: var(--axt-lime); color: #0a0c10; }
      .axt-exec:disabled { opacity: 0.5; cursor: not-allowed; }

      .axt-warn { font-size: 10.5px; line-height: 1.5; color: light-dark(#92500a, #f0b15a); padding: 6px 9px; border: 1px solid var(--axt-line); border-radius: 8px; background: var(--axt-soft); }
      .axt-status { font-size: 11px; color: var(--axt-lime-ink); text-align: center; }
      .axt-err { font-size: 11px; color: var(--axt-sell); text-align: center; word-break: break-word; }

      .axt-fills { max-height: 150px; overflow-y: auto; border: 1px solid var(--axt-line); border-radius: 8px; background: light-dark(rgba(9,9,11,0.012), rgba(0,0,0,0.16)); }
      .axt-fills-empty { font-size: 11px; color: var(--axt-ink3); padding: 0.9rem; text-align: center; }
      .axt-fill { display: grid; grid-template-columns: auto auto auto 1fr auto; gap: 9px; align-items: center; padding: 7px 10px; font-size: 11px; border-bottom: 1px solid var(--axt-soft); text-decoration: none; color: inherit; }
      .axt-fill:last-child { border-bottom: none; }
      .axt-fill:hover { background: var(--axt-soft); }
      .axt-fill-side { font-weight: 700; font-size: 9.5px; letter-spacing: 0.06em; }
      .axt-buy-t { color: var(--axt-buy); }
      .axt-sell-t { color: var(--axt-sell); }
      .axt-fill-amt { color: var(--axt-ink2); }
      .axt-fill-arrow { color: var(--axt-ink3); }
      .axt-fill-link { color: var(--axt-ink3); justify-self: end; }

      .axt-foot { padding: 0.55rem 0.9rem; font-size: 10px; line-height: 1.5; color: var(--axt-ink3); border-top: 1px solid var(--axt-line); }

      @media (max-width: 520px) {
        .axt-ticket { grid-template-columns: 1fr; }
      }
    `}</style>
  );
}
