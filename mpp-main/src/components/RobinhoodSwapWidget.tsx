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
  hasWallet,
  injected,
  inputTokenFor,
  isConfigured,
  publicClient,
  quoteExactIn,
  type Side,
  swapExactIn,
} from "../lib/robinhood-swap";

// ---------------------------------------------------------------------------
// AXIS on Robinhood Chain — REAL on-chain ETH↔AXIS swaps against the Uniswap v4
// pool on Robinhood Chain. Same mechanics as the Base Market widget: live quote
// from the v4 Quoter, execution via the Universal Router, signed by your wallet.
// AXIS here is the bridged OFT (1:1 with Base AXIS).
// ---------------------------------------------------------------------------

const POOL_FEE = 0.01;
const SLIPPAGE_OPTS = [50, 100, 300];
const IDLE_MS = 15 * 60 * 1000;
const fmt = (n: number, d = 2) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

type Row = {
  hash: string;
  side: Side;
  pay: string;
  receive: string;
  ts: number;
};

export function RobinhoodSwapWidget({ className }: { className?: string }) {
  const configured = isConfigured();
  const [account, setAccount] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [balances, setBalances] = useState<Balances | null>(null);

  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("0.01");
  const [slippageBps, setSlippageBps] = useState(100);

  const [spotEth, setSpotEth] = useState<number | null>(null); // ETH per AXIS
  const [quoteOut, setQuoteOut] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [idleLoggedOut, setIdleLoggedOut] = useState(false);

  const walletPresent = hasWallet();
  const unitIn = side === "buy" ? "ETH" : "AXIS";
  const unitOut = side === "buy" ? "AXIS" : "ETH";
  const dpIn = side === "buy" ? 5 : 2;
  const dpOut = side === "buy" ? 2 : 5;

  const refreshBalances = useCallback(async (addr: string) => {
    try {
      setBalances(await getBalances(addr));
    } catch {
      /* ignore */
    }
  }, []);

  const refreshSpot = useCallback(async () => {
    if (!configured) return;
    try {
      setSpotEth(await getSpotEth());
    } catch {
      /* ignore */
    }
  }, [configured]);

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

  useEffect(() => {
    const eth = injected();
    if (!eth?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const a =
        Array.isArray(args[0]) && args[0][0] ? String(args[0][0]) : null;
      setAccount(a);
      setBalances(null);
      if (a) void refreshBalances(a);
    };
    eth.on("accountsChanged", onAccounts);
    return () => eth.removeListener?.("accountsChanged", onAccounts);
  }, [refreshBalances]);

  const parseAmountIn = useCallback((): bigint | null => {
    try {
      const raw = parseUnits((amount || "0").trim(), 18);
      return raw > 0n ? raw : null;
    } catch {
      return null;
    }
  }, [amount]);

  useEffect(() => {
    if (!configured) return;
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
  }, [side, parseAmountIn, configured]);

  const amountInNum = Number.parseFloat(amount) || 0;
  const outNum = quoteOut ? Number(formatUnits(quoteOut, 18)) : 0;
  const effPrice =
    side === "buy"
      ? outNum > 0
        ? amountInNum / outNum
        : 0
      : amountInNum > 0
        ? outNum / amountInNum
        : 0;
  const impactPct =
    spotEth && effPrice > 0
      ? Math.abs((effPrice - spotEth) / spotEth) * 100
      : 0;
  const minOut = quoteOut
    ? (quoteOut * BigInt(10_000 - slippageBps)) / 10_000n
    : 0n;
  const minOutNum = Number(formatUnits(minOut, 18));
  const balIn =
    balances == null
      ? null
      : side === "buy"
        ? Number(formatUnits(balances.ethRaw, 18))
        : Number(formatUnits(balances.axisRaw, 18));
  const insufficient = balIn != null && amountInNum > balIn + 1e-9;

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
      /* ignore */
    }
  }, []);

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
      const recvNum = Number(formatUnits(out, 18));
      setRows((prev) =>
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
    <div className={`axr ${className ?? ""}`}>
      <Styles />
      <div className="axr-bar">
        <div className="axr-dots">
          <span />
        </div>
        <div className="axr-title">axis · robinhood swap</div>
        <div className="axr-mode">
          <span className="axr-mode-dot" />
          LIVE · UNISWAP v4
        </div>
      </div>

      <div className="axr-body">
        {!configured ? (
          <div className="axr-empty">Robinhood swap isn't configured yet.</div>
        ) : (
          <>
            <div className="axr-price">
              <span className="axr-price-dot" />
              <span>
                1 AXIS ={" "}
                <b>
                  {spotEth != null ? `${spotEth.toExponential(3)} ETH` : "…"}
                </b>
              </span>
              <span className="axr-chain">Robinhood Chain</span>
            </div>

            {account ? (
              <div className="axr-wallet">
                <span className="axr-acct">
                  <span className="axr-acct-dot" />
                  {shortAddress(account)}
                </span>
                <span className="axr-right">
                  <span className="axr-bals">
                    {balances ? (
                      <>
                        <span>
                          {fmt(Number(formatUnits(balances.axisRaw, 18)), 2)}{" "}
                          AXIS
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
                    className="axr-disc"
                    onClick={() => void disconnect(false)}
                  >
                    Disconnect
                  </button>
                </span>
              </div>
            ) : (
              <>
                {idleLoggedOut && (
                  <div className="axr-idle">
                    🔒 Disconnected after 15 min idle — reconnect to trade.
                  </div>
                )}
                <button
                  type="button"
                  className="axr-connect"
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

            <div className="axr-ticket">
              <div className="axr-side">
                <button
                  type="button"
                  className={`axr-side-btn ${side === "buy" ? "axr-buy" : ""}`}
                  onClick={() => {
                    setSide("buy");
                    setAmount("0.01");
                  }}
                >
                  Buy
                </button>
                <button
                  type="button"
                  className={`axr-side-btn ${side === "sell" ? "axr-sell" : ""}`}
                  onClick={() => {
                    setSide("sell");
                    setAmount("1000");
                  }}
                >
                  Sell
                </button>
              </div>
              <div className="axr-amount">
                <input
                  className="axr-amount-input"
                  type="number"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.0"
                />
                <span className="axr-amount-unit">{unitIn}</span>
              </div>
            </div>

            <div className="axr-slip">
              <span className="axr-slip-label">Max slippage</span>
              {SLIPPAGE_OPTS.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  className={`axr-slip-btn ${slippageBps === bps ? "axr-slip-on" : ""}`}
                  onClick={() => setSlippageBps(bps)}
                >
                  {bps / 100}%
                </button>
              ))}
            </div>

            {quoteOut && amountInNum > 0 ? (
              <div className="axr-quote">
                <div className="axr-q-row axr-q-head">
                  <span>
                    {side === "buy" ? "Buy" : "Sell"} {unitOut}
                  </span>
                  <span className="axr-q-price">
                    impact {fmt(impactPct, 2)}%
                  </span>
                </div>
                <div className="axr-q-row">
                  <span>You pay</span>
                  <span className="axr-num">
                    {fmt(amountInNum, dpIn)} {unitIn}
                  </span>
                </div>
                <div className="axr-q-row">
                  <span>You receive (est.)</span>
                  <span className="axr-num axr-rec">
                    {fmt(outNum, dpOut)} {unitOut}
                  </span>
                </div>
                <div className="axr-q-row axr-q-sub">
                  <span>Min received ({slippageBps / 100}%)</span>
                  <span className="axr-num">
                    {fmt(minOutNum, dpOut)} {unitOut}
                  </span>
                </div>
                <div className="axr-q-row axr-q-sub">
                  <span>Pool fee</span>
                  <span className="axr-num">{POOL_FEE * 100}%</span>
                </div>
              </div>
            ) : (
              <div className="axr-empty">
                {quoting
                  ? "Fetching live quote…"
                  : quoteErr
                    ? quoteErr
                    : "Enter an amount for a live on-chain quote."}
              </div>
            )}

            <button
              type="button"
              className="axr-exec"
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

            {status && <div className="axr-status">{status}</div>}
            {error && <div className="axr-err">{error}</div>}

            <div className="axr-fills">
              {rows.length === 0 ? (
                <div className="axr-fills-empty">
                  Your swaps this session will appear here.
                </div>
              ) : (
                rows.map((s) => (
                  <a
                    key={s.hash}
                    className="axr-fill"
                    href={`https://robinhoodchain.blockscout.com/tx/${s.hash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span
                      className={`axr-fill-side ${s.side === "buy" ? "axr-buy-t" : "axr-sell-t"}`}
                    >
                      {s.side === "buy" ? "BUY" : "SELL"}
                    </span>
                    <span className="axr-fill-amt">{s.pay}</span>
                    <span className="axr-fill-arrow">→</span>
                    <span className="axr-num axr-rec">{s.receive}</span>
                    <span className="axr-fill-link">↗</span>
                  </a>
                ))
              )}
            </div>
          </>
        )}
      </div>

      <div className="axr-foot">
        Real ETH ↔ AXIS swaps on Robinhood Chain via Uniswap v4. AXIS here is
        the bridged 1:1 representation. Quotes read live from the pool; trades
        are signed by your own wallet. Auto-disconnects after 15 min idle.
      </div>
    </div>
  );
}

function Styles() {
  return (
    <style>{`
      .axr { --axr-line: light-dark(rgba(9,9,11,0.10), rgba(255,255,255,0.09)); --axr-soft: light-dark(rgba(9,9,11,0.028), rgba(255,255,255,0.03));
        --axr-acc: light-dark(#1f9d63, #7fe0a8); --axr-ink: var(--vocs-text-color-heading); --axr-ink2: var(--vocs-text-color-secondary); --axr-ink3: var(--vocs-text-color-muted);
        --axr-buy: light-dark(#15803d, #4ade80); --axr-sell: light-dark(#b91c1c, #f0857d);
        display:flex; flex-direction:column; width:100%; border:1px solid var(--axr-line); border-radius:14px; overflow:hidden;
        background: light-dark(rgba(255,255,255,0.5), rgba(255,255,255,0.012)); font-family: var(--font-mono,"Geist Mono",monospace); color: var(--axr-ink); }
      .axr-bar { display:flex; align-items:center; gap:0.6rem; padding:0.55rem 0.9rem; border-bottom:1px solid var(--axr-line); }
      .axr-dots span { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--axr-acc); box-shadow:0 0 7px var(--axr-acc); }
      .axr-title { font-size:11.5px; color:var(--axr-ink3); letter-spacing:0.1em; text-transform:uppercase; }
      .axr-mode { margin-left:auto; display:flex; align-items:center; gap:6px; font-size:9.5px; letter-spacing:0.12em; padding:2px 9px; border-radius:999px; border:1px solid var(--axr-line); color:var(--axr-ink3); }
      .axr-mode-dot { width:6px; height:6px; border-radius:50%; background:var(--axr-acc); box-shadow:0 0 7px var(--axr-acc); }
      .axr-body { display:flex; flex-direction:column; gap:0.8rem; padding:0.9rem; }
      .axr-price { display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--axr-ink2); }
      .axr-price b { color:var(--axr-ink); font-variant-numeric:tabular-nums; }
      .axr-price-dot { width:6px; height:6px; border-radius:50%; background:var(--axr-acc); box-shadow:0 0 7px var(--axr-acc); }
      .axr-chain { margin-left:auto; font-size:10px; color:var(--axr-ink3); }
      .axr-wallet { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 10px; border:1px solid var(--axr-line); border-radius:8px; background:var(--axr-soft); font-size:11px; }
      .axr-acct { display:inline-flex; align-items:center; gap:6px; color:var(--axr-ink2); font-variant-numeric:tabular-nums; }
      .axr-acct-dot { width:6px; height:6px; border-radius:50%; background:var(--axr-buy); }
      .axr-right { display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
      .axr-bals { display:inline-flex; gap:10px; color:var(--axr-ink3); font-variant-numeric:tabular-nums; flex-wrap:wrap; justify-content:flex-end; }
      .axr-disc { padding:4px 9px; border-radius:6px; font-size:10px; cursor:pointer; border:1px solid var(--axr-line); background:transparent; color:var(--axr-ink3); white-space:nowrap; }
      .axr-disc:hover { color:var(--axr-sell); border-color:var(--axr-sell); }
      .axr-idle { font-size:10.5px; line-height:1.4; color:light-dark(#92500a,#f0b15a); padding:7px 9px; border:1px solid var(--axr-line); border-radius:8px; background:var(--axr-soft); }
      .axr-connect { padding:10px; border-radius:8px; font-size:12.5px; font-weight:600; cursor:pointer; border:1px solid var(--axr-acc); background:transparent; color:var(--axr-acc); }
      .axr-connect:disabled { opacity:0.55; cursor:not-allowed; }
      .axr-ticket { display:grid; grid-template-columns:auto 1fr; gap:8px; align-items:center; }
      .axr-side { display:inline-flex; border:1px solid var(--axr-line); border-radius:8px; overflow:hidden; }
      .axr-side-btn { padding:7px 14px; font-size:12.5px; font-weight:600; cursor:pointer; background:transparent; border:none; color:var(--axr-ink3); font-family:inherit; }
      .axr-side-btn.axr-buy { background:var(--axr-buy); color:#04130a; }
      .axr-side-btn.axr-sell { background:var(--axr-sell); color:#fff; }
      .axr-amount { display:flex; align-items:center; gap:6px; border:1px solid var(--axr-line); border-radius:8px; padding:0 10px; background:var(--vocs-background-color-primary); }
      .axr-amount-input { flex:1; width:100%; border:none; background:transparent; color:var(--axr-ink); font-family:inherit; font-size:14px; padding:7px 0; outline:none; }
      .axr-amount-unit { font-size:10px; color:var(--axr-acc); letter-spacing:0.06em; }
      .axr-slip { display:flex; align-items:center; gap:6px; font-size:10.5px; color:var(--axr-ink3); }
      .axr-slip-label { margin-right:auto; text-transform:uppercase; letter-spacing:0.06em; }
      .axr-slip-btn { padding:4px 9px; border-radius:6px; font-size:11px; cursor:pointer; border:1px solid var(--axr-line); background:transparent; color:var(--axr-ink2); font-family:inherit; }
      .axr-slip-on { background:var(--axr-acc); color:#0a0c10; border-color:var(--axr-acc); font-weight:600; }
      .axr-empty { font-size:11.5px; line-height:1.6; color:var(--axr-ink3); padding:0.9rem; text-align:center; border:1px dashed var(--axr-line); border-radius:10px; }
      .axr-num { font-variant-numeric:tabular-nums; }
      .axr-quote { border:1px solid var(--axr-line); border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:7px; background:var(--axr-soft); }
      .axr-q-row { display:flex; justify-content:space-between; font-size:12.5px; color:var(--axr-ink2); }
      .axr-q-head { font-weight:600; color:var(--axr-ink); }
      .axr-q-price { color:var(--axr-acc); }
      .axr-q-sub { font-size:11px; color:var(--axr-ink3); }
      .axr-rec { color:var(--axr-ink); font-weight:600; }
      .axr-exec { margin-top:2px; padding:11px; border-radius:8px; font-size:13px; font-weight:700; cursor:pointer; border:1px solid var(--axr-acc); background:var(--axr-acc); color:#04130a; }
      .axr-exec:disabled { opacity:0.5; cursor:not-allowed; }
      .axr-status { font-size:11px; color:var(--axr-acc); text-align:center; }
      .axr-err { font-size:11px; color:var(--axr-sell); text-align:center; word-break:break-word; }
      .axr-fills { max-height:150px; overflow-y:auto; border:1px solid var(--axr-line); border-radius:8px; background:light-dark(rgba(9,9,11,0.012),rgba(0,0,0,0.16)); }
      .axr-fills-empty { font-size:11px; color:var(--axr-ink3); padding:0.9rem; text-align:center; }
      .axr-fill { display:grid; grid-template-columns:auto auto auto 1fr auto; gap:9px; align-items:center; padding:7px 10px; font-size:11px; border-bottom:1px solid var(--axr-soft); text-decoration:none; color:inherit; }
      .axr-fill:last-child { border-bottom:none; }
      .axr-fill:hover { background:var(--axr-soft); }
      .axr-fill-side { font-weight:700; font-size:9.5px; letter-spacing:0.06em; }
      .axr-buy-t { color:var(--axr-buy); } .axr-sell-t { color:var(--axr-sell); }
      .axr-fill-amt { color:var(--axr-ink2); } .axr-fill-arrow { color:var(--axr-ink3); } .axr-fill-link { color:var(--axr-ink3); justify-self:end; }
      .axr-foot { padding:0.55rem 0.9rem; font-size:10px; line-height:1.5; color:var(--axr-ink3); border-top:1px solid var(--axr-line); }
      @media (max-width:520px){ .axr-ticket { grid-template-columns:1fr; } }
    `}</style>
  );
}
