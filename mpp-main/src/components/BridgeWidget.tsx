"use client";

import { useCallback, useEffect, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { shortAddress } from "../lib/axis";
import {
  type BridgeBalances,
  connectWallet,
  currentAccount,
  type Dir,
  ensureApproval,
  explorerTx,
  getBridgeBalances,
  hasWallet,
  injected,
  quoteBridge,
  sendBridge,
} from "../lib/bridge";
import { lockWallet, useSessionWallet } from "../lib/wallet-session";

// ---------------------------------------------------------------------------
// AXIS Bridge — REAL cross-chain transfers Base ⇄ Robinhood Chain via the
// LayerZero OFT bridge. 1:1, supply-conserved, ownerless contracts. The user
// signs in their own wallet; the source tx settles, then LayerZero delivers to
// the destination chain (~1–3 min).
// ---------------------------------------------------------------------------

const IDLE_MS = 15 * 60 * 1000;
const fmt = (n: number, d = 4) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

type Row = { hash: string; dir: Dir; amount: string; ts: number };

export function BridgeWidget({ className }: { className?: string }) {
  const [dir, setDir] = useState<Dir>("toRobinhood");
  const [account, setAccount] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [balances, setBalances] = useState<BridgeBalances | null>(null);

  const [amount, setAmount] = useState("100");
  const [feeWei, setFeeWei] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [idleLoggedOut, setIdleLoggedOut] = useState(false);

  const session = useSessionWallet();
  const walletPresent = !!session || hasWallet();
  const srcLabel = dir === "toRobinhood" ? "Base" : "Robinhood";
  const dstLabel = dir === "toRobinhood" ? "Robinhood" : "Base";
  const amountNum = Number.parseFloat(amount) || 0;

  const refreshBalances = useCallback(async (addr: string) => {
    try {
      setBalances(await getBridgeBalances(addr));
    } catch {
      /* RPC hiccup — keep stale */
    }
  }, []);

  useEffect(() => {
    void currentAccount().then((a) => {
      if (a) {
        setAccount(a);
        void refreshBalances(a);
      }
    });
  }, [refreshBalances]);

  // Adopt the shared in-app wallet the moment it's unlocked (e.g. from the
  // wallet home) — this is what makes the bridge work inside Telegram.
  useEffect(() => {
    if (session) {
      setAccount(session.address);
      void refreshBalances(session.address);
    }
  }, [session, refreshBalances]);

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

  const parseAmount = useCallback((): bigint | null => {
    try {
      const raw = parseUnits((amount || "0").trim(), 18);
      return raw > 0n ? raw : null;
    } catch {
      return null;
    }
  }, [amount]);

  // Debounced fee quote whenever direction / amount / account changes.
  useEffect(() => {
    setQuoteErr(null);
    const raw = parseAmount();
    if (!raw || !account) {
      setFeeWei(null);
      return;
    }
    let alive = true;
    setQuoting(true);
    const t = setTimeout(async () => {
      try {
        const { nativeFee } = await quoteBridge(dir, account, raw);
        if (alive) setFeeWei(nativeFee);
      } catch {
        if (alive) {
          setFeeWei(null);
          setQuoteErr("Couldn't fetch the bridge fee — try again.");
        }
      } finally {
        if (alive) setQuoting(false);
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [dir, account, parseAmount]);

  const srcAxis =
    balances == null
      ? null
      : dir === "toRobinhood"
        ? Number(formatUnits(balances.axisBaseRaw, 18))
        : Number(formatUnits(balances.axisHoodRaw, 18));
  const srcEth =
    balances == null
      ? null
      : dir === "toRobinhood"
        ? Number(formatUnits(balances.ethBaseRaw, 18))
        : Number(formatUnits(balances.ethHoodRaw, 18));
  const insufficientAxis = srcAxis != null && amountNum > srcAxis + 1e-9;
  const feeEth = feeWei != null ? Number(formatUnits(feeWei, 18)) : null;
  const noGas = srcEth != null && feeEth != null && srcEth < feeEth;

  const onConnect = useCallback(async () => {
    setError(null);
    setConnecting(true);
    try {
      const a = await connectWallet(dir);
      setAccount(a);
      setIdleLoggedOut(false);
      await refreshBalances(a);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? "Failed to connect wallet.");
    } finally {
      setConnecting(false);
    }
  }, [dir, refreshBalances]);

  const disconnect = useCallback(async (idle: boolean) => {
    setAccount(null);
    setBalances(null);
    setFeeWei(null);
    setStatus(null);
    setError(null);
    setIdleLoggedOut(idle);
    lockWallet(); // also lock the shared in-app session, if any
    try {
      await injected()?.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      /* wallet may not support revoke */
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

  const onBridge = useCallback(async () => {
    setError(null);
    if (!account) {
      void onConnect();
      return;
    }
    const raw = parseAmount();
    if (!raw) {
      setError("Enter an amount.");
      return;
    }
    setBusy(true);
    try {
      if (dir === "toRobinhood") {
        await ensureApproval(dir, account, raw, setStatus);
      }
      setStatus("Bridging — confirm in your wallet…");
      const { hash } = await sendBridge(dir, account, raw);
      setStatus(
        "Submitted — LayerZero is delivering to " + dstLabel + " (~1–3 min)…",
      );
      setRows((prev) =>
        [
          { hash, dir, amount: `${fmt(amountNum, 2)} AXIS`, ts: Date.now() },
          ...prev,
        ].slice(0, 12),
      );
      // Give the source tx a moment, then refresh balances.
      setTimeout(() => void refreshBalances(account), 6000);
      setStatus(`✓ Sent from ${srcLabel} — arriving on ${dstLabel} shortly`);
      setTimeout(() => setStatus(null), 6000);
    } catch (e: unknown) {
      const msg = e as { shortMessage?: string; message?: string };
      const text = msg.shortMessage || msg.message || "Bridge failed.";
      setError(
        /user rejected|denied/i.test(text)
          ? "Transaction rejected in wallet."
          : text.slice(0, 180),
      );
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, [
    account,
    dir,
    amountNum,
    srcLabel,
    dstLabel,
    onConnect,
    parseAmount,
    refreshBalances,
  ]);

  const execLabel = !account ? "Connect wallet" : `Bridge to ${dstLabel}`;

  return (
    <div className={`axb ${className ?? ""}`}>
      <Styles />

      <div className="axb-bar">
        <div className="axb-dots">
          <span />
        </div>
        <div className="axb-title">axis · bridge</div>
        <div className="axb-mode">
          <span className="axb-mode-dot" />
          LIVE · LAYERZERO
        </div>
      </div>

      <div className="axb-body">
        {/* Direction */}
        <div className="axb-dir">
          <button
            type="button"
            className={`axb-dir-btn ${dir === "toRobinhood" ? "axb-on" : ""}`}
            onClick={() => setDir("toRobinhood")}
          >
            Base → Robinhood
          </button>
          <button
            type="button"
            className={`axb-dir-btn ${dir === "toBase" ? "axb-on" : ""}`}
            onClick={() => setDir("toBase")}
          >
            Robinhood → Base
          </button>
        </div>

        {/* Wallet */}
        {account ? (
          <div className="axb-wallet">
            <span className="axb-acct">
              <span className="axb-acct-dot" />
              {shortAddress(account)}
            </span>
            <span className="axb-right">
              <span className="axb-bals">
                {balances ? (
                  <>
                    <span>
                      {fmt(Number(formatUnits(balances.axisBaseRaw, 18)), 2)}{" "}
                      AXIS·Base
                    </span>
                    <span>
                      {fmt(Number(formatUnits(balances.axisHoodRaw, 18)), 2)}{" "}
                      AXIS·Hood
                    </span>
                  </>
                ) : (
                  <span>loading…</span>
                )}
              </span>
              <button
                type="button"
                className="axb-disc"
                onClick={() => void disconnect(false)}
              >
                Disconnect
              </button>
            </span>
          </div>
        ) : (
          <>
            {idleLoggedOut && (
              <div className="axb-idle">
                🔒 Disconnected after 15 min of inactivity — reconnect to
                bridge.
              </div>
            )}
            <button
              type="button"
              className="axb-connect"
              onClick={onConnect}
              disabled={connecting || !walletPresent}
            >
              {!walletPresent
                ? "Unlock your AXIS wallet to bridge"
                : connecting
                  ? "Connecting…"
                  : "Connect wallet to bridge"}
            </button>
          </>
        )}

        {/* Amount */}
        <div className="axb-amount">
          <input
            className="axb-amount-input"
            type="number"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
          />
          <span className="axb-amount-unit">AXIS</span>
        </div>

        {/* Summary */}
        <div className="axb-quote">
          <div className="axb-q-row axb-q-head">
            <span>
              {srcLabel} → {dstLabel}
            </span>
            <span className="axb-q-rate">1 : 1</span>
          </div>
          <div className="axb-q-row">
            <span>You send</span>
            <span className="axb-num">{fmt(amountNum, 2)} AXIS</span>
          </div>
          <div className="axb-q-row">
            <span>You receive</span>
            <span className="axb-num axb-rec">
              {fmt(amountNum, 2)} AXIS on {dstLabel}
            </span>
          </div>
          <div className="axb-q-row axb-q-sub">
            <span>Bridge fee (LayerZero, on {srcLabel})</span>
            <span className="axb-num">
              {quoting
                ? "…"
                : feeEth != null
                  ? `${feeEth.toExponential(2)} ETH`
                  : "—"}
            </span>
          </div>
        </div>

        <button
          type="button"
          className="axb-exec"
          onClick={onBridge}
          disabled={
            busy ||
            (!!account &&
              (amountNum <= 0 || insufficientAxis || feeWei == null))
          }
        >
          {busy
            ? "Working…"
            : insufficientAxis
              ? `Insufficient AXIS on ${srcLabel}`
              : execLabel}
        </button>

        {noGas && account && (
          <div className="axb-warn">
            ⚠ Not enough ETH on {srcLabel} to cover the bridge fee — add a
            little ETH there.
          </div>
        )}
        {quoteErr && <div className="axb-warn">{quoteErr}</div>}
        {status && <div className="axb-status">{status}</div>}
        {error && <div className="axb-err">{error}</div>}

        <div className="axb-fills">
          {rows.length === 0 ? (
            <div className="axb-fills-empty">
              Your bridge transfers this session will appear here.
            </div>
          ) : (
            rows.map((r) => (
              <a
                key={r.hash}
                className="axb-fill"
                href={explorerTx(r.dir, r.hash)}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="axb-fill-dir">
                  {r.dir === "toRobinhood" ? "→ HOOD" : "→ BASE"}
                </span>
                <span className="axb-fill-amt">{r.amount}</span>
                <span className="axb-fill-note">delivering…</span>
                <span className="axb-fill-link">↗</span>
              </a>
            ))
          )}
        </div>
      </div>

      <div className="axb-foot">
        Real 1:1 bridge on the LayerZero OFT (2-DVN verified, ownerless). AXIS
        locks on Base and mints on Robinhood (and burns back). Delivery to the
        other chain takes ~1–3 minutes after your source-chain tx confirms.
      </div>
    </div>
  );
}

function Styles() {
  return (
    <style>{`
      .axb {
        --axb-line: light-dark(rgba(9,9,11,0.10), rgba(255,255,255,0.09));
        --axb-soft: light-dark(rgba(9,9,11,0.028), rgba(255,255,255,0.03));
        --axb-acc: light-dark(#1f9d63, #7fe0a8);
        --axb-ink: var(--vocs-text-color-heading);
        --axb-ink2: var(--vocs-text-color-secondary);
        --axb-ink3: var(--vocs-text-color-muted);
        --axb-sell: light-dark(#b91c1c, #f0857d);
        display: flex; flex-direction: column; width: 100%;
        border: 1px solid var(--axb-line); border-radius: 14px; overflow: hidden;
        background: light-dark(rgba(255,255,255,0.5), rgba(255,255,255,0.012));
        font-family: var(--font-mono, "Geist Mono", monospace); color: var(--axb-ink);
      }
      .axb-bar { display: flex; align-items: center; gap: 0.6rem; padding: 0.55rem 0.9rem; border-bottom: 1px solid var(--axb-line); }
      .axb-dots span { display:inline-block; width:7px; height:7px; border-radius:50%; background: var(--axb-acc); box-shadow: 0 0 7px var(--axb-acc); }
      .axb-title { font-size: 11.5px; color: var(--axb-ink3); letter-spacing: 0.1em; text-transform: uppercase; }
      .axb-mode { margin-left: auto; display: flex; align-items: center; gap: 6px; font-size: 9.5px; letter-spacing: 0.12em; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--axb-line); color: var(--axb-ink3); }
      .axb-mode-dot { width:6px; height:6px; border-radius:50%; background: var(--axb-acc); box-shadow: 0 0 7px var(--axb-acc); }
      .axb-body { display: flex; flex-direction: column; gap: 0.8rem; padding: 0.9rem; }

      .axb-dir { display: flex; border: 1px solid var(--axb-line); border-radius: 8px; overflow: hidden; }
      .axb-dir-btn { flex: 1; padding: 8px 10px; font-size: 12px; font-weight: 600; cursor: pointer; background: transparent; border: none; color: var(--axb-ink3); font-family: inherit; }
      .axb-dir-btn.axb-on { background: var(--axb-acc); color: #04130a; }

      .axb-wallet { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; border: 1px solid var(--axb-line); border-radius: 8px; background: var(--axb-soft); font-size: 11px; }
      .axb-acct { display: inline-flex; align-items: center; gap: 6px; color: var(--axb-ink2); font-variant-numeric: tabular-nums; }
      .axb-acct-dot { width:6px; height:6px; border-radius:50%; background: var(--axb-acc); }
      .axb-right { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
      .axb-bals { display: inline-flex; gap: 10px; color: var(--axb-ink3); font-variant-numeric: tabular-nums; flex-wrap: wrap; justify-content: flex-end; }
      .axb-disc { padding: 4px 9px; border-radius: 6px; font-size: 10px; cursor: pointer; border: 1px solid var(--axb-line); background: transparent; color: var(--axb-ink3); white-space: nowrap; }
      .axb-disc:hover { color: var(--axb-sell); border-color: var(--axb-sell); }
      .axb-idle { font-size: 10.5px; line-height: 1.4; color: light-dark(#92500a, #f0b15a); padding: 7px 9px; border: 1px solid var(--axb-line); border-radius: 8px; background: var(--axb-soft); }
      .axb-connect { padding: 10px; border-radius: 8px; font-size: 12.5px; font-weight: 600; cursor: pointer; border: 1px solid var(--axb-acc); background: transparent; color: var(--axb-acc); }
      .axb-connect:disabled { opacity: 0.55; cursor: not-allowed; }

      .axb-amount { display: flex; align-items: center; gap: 6px; border: 1px solid var(--axb-line); border-radius: 8px; padding: 0 10px; background: var(--vocs-background-color-primary); }
      .axb-amount-input { flex: 1; width: 100%; border: none; background: transparent; color: var(--axb-ink); font-family: inherit; font-size: 14px; padding: 8px 0; outline: none; }
      .axb-amount-unit { font-size: 10px; color: var(--axb-acc); letter-spacing: 0.06em; }

      .axb-quote { border: 1px solid var(--axb-line); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 7px; background: var(--axb-soft); }
      .axb-q-row { display: flex; justify-content: space-between; font-size: 12.5px; color: var(--axb-ink2); }
      .axb-q-head { font-weight: 600; color: var(--axb-ink); }
      .axb-q-rate { color: var(--axb-acc); }
      .axb-q-sub { font-size: 11px; color: var(--axb-ink3); }
      .axb-num { font-variant-numeric: tabular-nums; }
      .axb-rec { color: var(--axb-ink); font-weight: 600; }

      .axb-exec { margin-top: 2px; padding: 11px; border-radius: 8px; font-size: 13px; font-weight: 700; cursor: pointer; border: 1px solid var(--axb-acc); background: var(--axb-acc); color: #04130a; }
      .axb-exec:disabled { opacity: 0.5; cursor: not-allowed; }
      .axb-warn { font-size: 10.5px; line-height: 1.5; color: light-dark(#92500a, #f0b15a); padding: 6px 9px; border: 1px solid var(--axb-line); border-radius: 8px; background: var(--axb-soft); }
      .axb-status { font-size: 11px; color: var(--axb-acc); text-align: center; }
      .axb-err { font-size: 11px; color: var(--axb-sell); text-align: center; word-break: break-word; }

      .axb-fills { max-height: 150px; overflow-y: auto; border: 1px solid var(--axb-line); border-radius: 8px; background: light-dark(rgba(9,9,11,0.012), rgba(0,0,0,0.16)); }
      .axb-fills-empty { font-size: 11px; color: var(--axb-ink3); padding: 0.9rem; text-align: center; }
      .axb-fill { display: grid; grid-template-columns: auto 1fr auto auto; gap: 9px; align-items: center; padding: 7px 10px; font-size: 11px; border-bottom: 1px solid var(--axb-soft); text-decoration: none; color: inherit; }
      .axb-fill:last-child { border-bottom: none; }
      .axb-fill:hover { background: var(--axb-soft); }
      .axb-fill-dir { font-weight: 700; font-size: 9.5px; letter-spacing: 0.06em; color: var(--axb-acc); }
      .axb-fill-amt { color: var(--axb-ink2); }
      .axb-fill-note { color: var(--axb-ink3); font-size: 10px; }
      .axb-fill-link { color: var(--axb-ink3); justify-self: end; }
      .axb-foot { padding: 0.55rem 0.9rem; font-size: 10px; line-height: 1.5; color: var(--axb-ink3); border-top: 1px solid var(--axb-line); }
    `}</style>
  );
}
