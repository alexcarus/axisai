"use client";

// ---------------------------------------------------------------------------
// AXIS Wallet — unified self-custodial wallet home for the Telegram Mini App
// (and the web). One unlock, then balances + Bridge + Send + Receive, all
// signed locally by the in-app wallet (no browser extension required, so it
// works inside Telegram). Mining and trading link out to their pages.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";
import QRCode from "react-qr-code";
import {
  createWalletClient,
  formatUnits,
  getAddress,
  type Hex,
  http,
  isAddress,
  parseEther,
  parseUnits,
} from "viem";
import { base } from "viem/chains";
import { type MiningWallet, shortAddress, walletFromSecret } from "../lib/axis";
import {
  AXIS,
  BASE_RPC,
  type BridgeBalances,
  getBridgeBalances,
  OFT_ROBINHOOD,
  ROBINHOOD_RPC,
  robinhood,
} from "../lib/bridge";
import {
  lockWallet,
  setSessionWallet,
  touchSession,
  useSessionWallet,
} from "../lib/wallet-session";
import {
  freshWallet,
  hasVault,
  saveEncrypted,
  unlock,
  vaultAddress,
} from "../lib/wallet-store";
import { BridgeWidget } from "./BridgeWidget";
import { MiningWidget } from "./MiningWidget";

const ERC20_TRANSFER = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ type: "address" }, { type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const fmt = (n: number, d = 4) =>
  n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: d,
  });

const copy = (t: string) => {
  navigator.clipboard?.writeText(t).catch(() => {});
};

export function WalletApp({ className }: { className?: string }) {
  const session = useSessionWallet();
  return (
    <div className={`axw ${className ?? ""}`}>
      <WalletStyles />
      {session ? <Home wallet={session} /> : <Auth />}
    </div>
  );
}

// --------------------------------------------------------------------------
// Auth — unlock an existing vault, or create / import one.
// --------------------------------------------------------------------------

type Mode = "unlock" | "create" | "import";

function Auth() {
  const [mode, setMode] = useState<Mode>(() =>
    hasVault() ? "unlock" : "create",
  );
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [seedInput, setSeedInput] = useState("");
  const [draft, setDraft] = useState<MiningWallet | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh backup-able wallet to show when creating.
  useEffect(() => {
    if (mode === "create" && !draft) setDraft(freshWallet());
  }, [mode, draft]);

  const doUnlock = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const w = await unlock(password);
      if (!w) {
        setError("Wrong password, or no wallet on this device.");
        return;
      }
      setSessionWallet(w);
    } finally {
      setBusy(false);
    }
  }, [password]);

  const doCreate = useCallback(async () => {
    setError(null);
    if (!draft) return;
    if (password.length < 8)
      return setError("Use a password of at least 8 characters.");
    if (password !== confirm) return setError("Passwords don't match.");
    if (!ack)
      return setError("Confirm you've saved your recovery phrase first.");
    setBusy(true);
    try {
      await saveEncrypted(draft, password);
      setSessionWallet(draft);
    } finally {
      setBusy(false);
    }
  }, [draft, password, confirm, ack]);

  const doImport = useCallback(async () => {
    setError(null);
    const w = walletFromSecret(seedInput);
    if (!w)
      return setError("Enter a valid 12-word seed phrase or 0x private key.");
    if (password.length < 8)
      return setError("Use a password of at least 8 characters.");
    if (password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    try {
      await saveEncrypted(w, password);
      setSessionWallet(w);
    } finally {
      setBusy(false);
    }
  }, [seedInput, password, confirm]);

  return (
    <div className="axw-auth">
      <div className="axw-brand">
        <img src="/logo.png" alt="AXIS" width={40} height={40} />
        <div>
          <div className="axw-brand-t">AXIS Wallet</div>
          <div className="axw-brand-s">
            Self-custodial · Base &amp; Robinhood
          </div>
        </div>
      </div>

      <div className="axw-tabs">
        {hasVault() && (
          <button
            type="button"
            className={`axw-tab ${mode === "unlock" ? "axw-on" : ""}`}
            onClick={() => setMode("unlock")}
          >
            Unlock
          </button>
        )}
        <button
          type="button"
          className={`axw-tab ${mode === "create" ? "axw-on" : ""}`}
          onClick={() => setMode("create")}
        >
          Create
        </button>
        <button
          type="button"
          className={`axw-tab ${mode === "import" ? "axw-on" : ""}`}
          onClick={() => setMode("import")}
        >
          Import
        </button>
      </div>

      {mode === "unlock" && (
        <div className="axw-form">
          <input
            className="axw-input"
            type="password"
            placeholder="Wallet password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void doUnlock()}
          />
          <button
            type="button"
            className="axw-primary"
            onClick={() => void doUnlock()}
            disabled={busy}
          >
            {busy ? "Unlocking…" : "Unlock wallet"}
          </button>
        </div>
      )}

      {mode === "create" && (
        <div className="axw-form">
          <div className="axw-seed-label">
            Your recovery phrase — write it down, never share it
          </div>
          <div className="axw-seed">{draft?.mnemonic ?? "…"}</div>
          <div className="axw-seed-actions">
            <button
              type="button"
              className="axw-ghost"
              onClick={() => draft?.mnemonic && copy(draft.mnemonic)}
            >
              Copy phrase
            </button>
            <button
              type="button"
              className="axw-ghost"
              onClick={() => setDraft(freshWallet())}
            >
              Regenerate
            </button>
          </div>
          <input
            className="axw-input"
            type="password"
            placeholder="Set a password (min 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <input
            className="axw-input"
            type="password"
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <label className="axw-ack">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>I've saved my recovery phrase somewhere safe.</span>
          </label>
          <button
            type="button"
            className="axw-primary"
            onClick={() => void doCreate()}
            disabled={busy}
          >
            {busy ? "Creating…" : "Create wallet"}
          </button>
        </div>
      )}

      {mode === "import" && (
        <div className="axw-form">
          <textarea
            className="axw-textarea"
            placeholder="12-word seed phrase, or 0x private key"
            value={seedInput}
            onChange={(e) => setSeedInput(e.target.value)}
            rows={3}
          />
          <input
            className="axw-input"
            type="password"
            placeholder="Set a password (min 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <input
            className="axw-input"
            type="password"
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <button
            type="button"
            className="axw-primary"
            onClick={() => void doImport()}
            disabled={busy}
          >
            {busy ? "Importing…" : "Import wallet"}
          </button>
        </div>
      )}

      {error && <div className="axw-err">{error}</div>}
      <div className="axw-foot">
        Your key is encrypted with your password and stored only on this device
        — AXIS never sees it.
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Home — balances + Bridge / Send / Receive.
// --------------------------------------------------------------------------

type Tab = "overview" | "mine" | "bridge" | "send" | "receive";

function Home({ wallet }: { wallet: MiningWallet }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [balances, setBalances] = useState<BridgeBalances | null>(null);
  const addr = wallet.address;

  const refresh = useCallback(async () => {
    try {
      setBalances(await getBridgeBalances(addr));
    } catch {
      /* RPC hiccup — keep stale */
    }
  }, [addr]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reset the idle auto-lock on interaction inside the wallet.
  useEffect(() => {
    const bump = () => touchSession();
    const events = ["pointerdown", "keydown", "touchstart"];
    for (const ev of events)
      window.addEventListener(ev, bump, { passive: true });
    return () => {
      for (const ev of events) window.removeEventListener(ev, bump);
    };
  }, []);

  return (
    <div className="axw-home">
      <div className="axw-head">
        <button
          type="button"
          className="axw-acct"
          onClick={() => copy(addr)}
          title="Copy address"
        >
          <span className="axw-dot" />
          {shortAddress(addr)}
        </button>
        <button type="button" className="axw-lock" onClick={() => lockWallet()}>
          Lock
        </button>
      </div>

      <BackupBanner wallet={wallet} />
      <BalanceCard balances={balances} onRefresh={() => void refresh()} />

      <div className="axw-nav">
        {(["overview", "mine", "bridge", "send", "receive"] as Tab[]).map(
          (t) => (
            <button
              key={t}
              type="button"
              className={`axw-navbtn ${tab === t ? "axw-on" : ""}`}
              onClick={() => setTab(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ),
        )}
      </div>

      {tab === "overview" && (
        <div className="axw-tiles">
          <button
            type="button"
            className="axw-tile"
            onClick={() => setTab("mine")}
          >
            <span className="axw-tile-i">⛏️</span>Mine
          </button>
          <button
            type="button"
            className="axw-tile"
            onClick={() => setTab("bridge")}
          >
            <span className="axw-tile-i">🌉</span>Bridge
          </button>
          <a className="axw-tile" href="/market">
            <span className="axw-tile-i">📈</span>Trade
          </a>
          <button
            type="button"
            className="axw-tile"
            onClick={() => setTab("send")}
          >
            <span className="axw-tile-i">↗</span>Send
          </button>
          <button
            type="button"
            className="axw-tile"
            onClick={() => setTab("receive")}
          >
            <span className="axw-tile-i">↘</span>Receive
          </button>
          <a className="axw-tile" href="/bridge">
            <span className="axw-tile-i">💵</span>Buy
          </a>
        </div>
      )}

      {tab === "mine" && (
        <div className="axw-mine">
          <MiningWidget />
        </div>
      )}
      {tab === "bridge" && <BridgeWidget />}
      {tab === "send" && <Send wallet={wallet} onSent={() => void refresh()} />}
      {tab === "receive" && <Receive address={addr} />}
    </div>
  );
}

function BalanceCard({
  balances,
  onRefresh,
}: {
  balances: BridgeBalances | null;
  onRefresh: () => void;
}) {
  const rows: Array<[string, bigint | null]> = [
    ["AXIS · Base", balances?.axisBaseRaw ?? null],
    ["AXIS · Robinhood", balances?.axisHoodRaw ?? null],
    ["ETH · Base", balances?.ethBaseRaw ?? null],
    ["ETH · Robinhood", balances?.ethHoodRaw ?? null],
  ];
  return (
    <div className="axw-bal">
      <div className="axw-bal-head">
        <span>Balances</span>
        <button type="button" className="axw-refresh" onClick={onRefresh}>
          ↻
        </button>
      </div>
      <div className="axw-bal-grid">
        {rows.map(([label, raw]) => (
          <div key={label} className="axw-bal-row">
            <span className="axw-bal-l">{label}</span>
            <span className="axw-bal-v">
              {raw == null ? "…" : fmt(Number(formatUnits(raw, 18)), 4)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Shown only when the active wallet has no encrypted vault for its address yet
// (e.g. a throwaway wallet the miner auto-created). Lets the user back up the
// recovery phrase and encrypt+save it so it survives a refresh.
function BackupBanner({ wallet }: { wallet: MiningWallet }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const hasPhrase = Boolean(wallet.mnemonic);

  const save = useCallback(async () => {
    setError(null);
    if (pw.length < 8)
      return setError("Use a password of at least 8 characters.");
    if (pw !== pw2) return setError("Passwords don't match.");
    if (hasPhrase && !ack)
      return setError("Confirm you've saved your recovery phrase first.");
    setBusy(true);
    try {
      await saveEncrypted(wallet, pw);
      setSaved(true);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? "Couldn't save the wallet.");
    } finally {
      setBusy(false);
    }
  }, [pw, pw2, ack, hasPhrase, wallet]);

  const backedUp =
    saved ||
    (hasVault() &&
      vaultAddress()?.toLowerCase() === wallet.address.toLowerCase());
  if (backedUp) return null;

  return (
    <div className="axw-backup">
      <div className="axw-backup-head">
        <span>⚠ This wallet isn't backed up — it's lost if you refresh.</span>
        {!open && (
          <button
            type="button"
            className="axw-backup-cta"
            onClick={() => setOpen(true)}
          >
            Back up
          </button>
        )}
      </div>
      {open && (
        <div className="axw-form">
          {hasPhrase && (
            <>
              <div className="axw-seed-label">
                Recovery phrase — write it down, never share it
              </div>
              <div className="axw-seed">{wallet.mnemonic}</div>
              <div className="axw-seed-actions">
                <button
                  type="button"
                  className="axw-ghost"
                  onClick={() => wallet.mnemonic && copy(wallet.mnemonic)}
                >
                  Copy phrase
                </button>
              </div>
              <label className="axw-ack">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                <span>I've saved my recovery phrase somewhere safe.</span>
              </label>
            </>
          )}
          <input
            className="axw-input"
            type="password"
            placeholder="Set a password (min 8 chars)"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
          <input
            className="axw-input"
            type="password"
            placeholder="Confirm password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
          />
          <button
            type="button"
            className="axw-primary"
            onClick={() => void save()}
            disabled={busy}
          >
            {busy ? "Saving…" : "Encrypt & save"}
          </button>
          {error && <div className="axw-err">{error}</div>}
        </div>
      )}
    </div>
  );
}

function Send({
  wallet,
  onSent,
}: {
  wallet: MiningWallet;
  onSent: () => void;
}) {
  const [chainSel, setChainSel] = useState<"Base" | "Robinhood">("Base");
  const [asset, setAsset] = useState<"AXIS" | "ETH">("AXIS");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<Hex | null>(null);
  const onBase = chainSel === "Base";

  const send = useCallback(async () => {
    setError(null);
    setHash(null);
    if (!isAddress(to)) return setError("Enter a valid 0x recipient address.");
    const amt = Number.parseFloat(amount);
    if (!(amt > 0)) return setError("Enter an amount greater than 0.");
    setBusy(true);
    try {
      const wc = createWalletClient({
        account: wallet.account,
        chain: onBase ? base : robinhood,
        transport: http(onBase ? BASE_RPC : ROBINHOOD_RPC),
      });
      let tx: Hex;
      if (asset === "ETH") {
        tx = await wc.sendTransaction({
          to: getAddress(to),
          value: parseEther(amount),
        });
      } else {
        tx = await wc.writeContract({
          address: onBase ? AXIS : OFT_ROBINHOOD,
          abi: ERC20_TRANSFER,
          functionName: "transfer",
          args: [getAddress(to), parseUnits(amount, 18)],
        });
      }
      setHash(tx);
      setAmount("");
      setTimeout(onSent, 4000);
    } catch (e: unknown) {
      const m = e as { shortMessage?: string; message?: string };
      setError((m.shortMessage || m.message || "Send failed.").slice(0, 180));
    } finally {
      setBusy(false);
    }
  }, [onBase, asset, to, amount, wallet, onSent]);

  return (
    <div className="axw-panel">
      <div className="axw-seg">
        {(["Base", "Robinhood"] as const).map((c) => (
          <button
            key={c}
            type="button"
            className={`axw-seg-btn ${chainSel === c ? "axw-on" : ""}`}
            onClick={() => setChainSel(c)}
          >
            {c}
          </button>
        ))}
        <span className="axw-seg-note">chain</span>
      </div>
      <div className="axw-seg">
        {(["AXIS", "ETH"] as const).map((a) => (
          <button
            key={a}
            type="button"
            className={`axw-seg-btn ${asset === a ? "axw-on" : ""}`}
            onClick={() => setAsset(a)}
          >
            {a}
          </button>
        ))}
        <span className="axw-seg-note">asset</span>
      </div>
      <input
        className="axw-input"
        placeholder="Recipient 0x address"
        value={to}
        onChange={(e) => setTo(e.target.value)}
      />
      <input
        className="axw-input"
        type="number"
        min="0"
        placeholder={`Amount in ${asset}`}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <button
        type="button"
        className="axw-primary"
        onClick={() => void send()}
        disabled={busy}
      >
        {busy ? "Sending…" : `Send ${asset} on ${chainSel}`}
      </button>
      {error && <div className="axw-err">{error}</div>}
      {hash && (
        <a
          className="axw-ok"
          href={`${onBase ? "https://basescan.org/tx/" : "https://robinhoodchain.blockscout.com/tx/"}${hash}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          ✓ Sent — view on explorer ↗
        </a>
      )}
    </div>
  );
}

function Receive({ address }: { address: string }) {
  return (
    <div className="axw-panel">
      <div className="axw-recv-label">
        Your AXIS address (Base &amp; Robinhood — same address)
      </div>
      <div className="axw-qr">
        <QRCode
          value={address}
          size={168}
          level="M"
          bgColor="#ffffff"
          fgColor="#000000"
        />
      </div>
      <div className="axw-recv-addr">{address}</div>
      <button
        type="button"
        className="axw-primary"
        onClick={() => copy(address)}
      >
        Copy address
      </button>
      <div className="axw-foot">
        Scan the QR or copy the address to receive AXIS or ETH on Base or
        Robinhood Chain.
      </div>
    </div>
  );
}

function WalletStyles() {
  return (
    <style>{`
      .axw {
        --a: light-dark(#1f9d63, #7fe0a8);
        --line: light-dark(rgba(9,9,11,0.10), rgba(255,255,255,0.09));
        --soft: light-dark(rgba(9,9,11,0.028), rgba(255,255,255,0.03));
        --ink: var(--vocs-text-color-heading);
        --ink2: var(--vocs-text-color-secondary);
        --ink3: var(--vocs-text-color-muted);
        --sell: light-dark(#b91c1c, #f0857d);
        width: 100%; font-family: var(--font-mono, "Geist Mono", monospace); color: var(--ink);
      }
      .axw button { font-family: inherit; cursor: pointer; }
      .axw-auth, .axw-home { display: flex; flex-direction: column; gap: 0.85rem;
        border: 1px solid var(--line); border-radius: 14px; padding: 1rem;
        background: light-dark(rgba(255,255,255,0.5), rgba(255,255,255,0.012)); }

      .axw-brand { display: flex; align-items: center; gap: 10px; }
      .axw-brand img { border-radius: 9px; }
      .axw-brand-t { font-size: 15px; font-weight: 700; }
      .axw-brand-s { font-size: 10.5px; color: var(--ink3); }

      .axw-tabs, .axw-nav { display: flex; gap: 4px; border: 1px solid var(--line); border-radius: 9px; padding: 3px; }
      .axw-tab, .axw-navbtn { flex: 1; padding: 8px 6px; font-size: 12px; font-weight: 600; border: none;
        background: transparent; color: var(--ink3); border-radius: 6px; }
      .axw-tab.axw-on, .axw-navbtn.axw-on { background: var(--a); color: #04130a; }

      .axw-form, .axw-panel { display: flex; flex-direction: column; gap: 0.6rem; }
      .axw-input, .axw-textarea { width: 100%; border: 1px solid var(--line); border-radius: 8px;
        background: var(--vocs-background-color-primary); color: var(--ink); font-family: inherit;
        font-size: 13px; padding: 10px; outline: none; }
      .axw-textarea { resize: vertical; }
      .axw-primary { padding: 11px; border-radius: 8px; font-size: 13px; font-weight: 700;
        border: 1px solid var(--a); background: var(--a); color: #04130a; }
      .axw-primary:disabled { opacity: 0.5; cursor: not-allowed; }
      .axw-ghost { padding: 7px 10px; border-radius: 7px; font-size: 11px; border: 1px solid var(--line);
        background: transparent; color: var(--ink2); }

      .axw-seed-label { font-size: 10.5px; color: var(--ink3); }
      .axw-seed { border: 1px dashed var(--a); border-radius: 8px; padding: 10px; font-size: 13px;
        line-height: 1.7; letter-spacing: 0.02em; word-spacing: 4px; background: var(--soft); }
      .axw-seed-actions { display: flex; gap: 8px; }
      .axw-ack { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--ink2); }

      .axw-head { display: flex; align-items: center; justify-content: space-between; }
      .axw-acct { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line);
        border-radius: 999px; padding: 6px 12px; background: var(--soft); color: var(--ink2);
        font-size: 12px; font-variant-numeric: tabular-nums; }
      .axw-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--a); box-shadow: 0 0 7px var(--a); }
      .axw-lock { border: 1px solid var(--line); background: transparent; color: var(--ink3);
        border-radius: 7px; padding: 6px 12px; font-size: 11px; font-weight: 600; }
      .axw-backup { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; border-radius: 10px;
        border: 1px solid light-dark(#d8b400, #6b5e1d); background: light-dark(rgba(216,180,0,0.06), rgba(224,197,74,0.06)); }
      .axw-backup-head { display: flex; align-items: center; gap: 10px; font-size: 11px; line-height: 1.4; color: light-dark(#92500a, #f0c14a); }
      .axw-backup-cta { margin-left: auto; white-space: nowrap; cursor: pointer; border: 1px solid var(--a); background: var(--a); color: #04130a; border-radius: 7px; padding: 6px 12px; font-size: 11px; font-weight: 700; }

      .axw-bal { border: 1px solid var(--line); border-radius: 12px; background: var(--soft); padding: 12px; }
      .axw-bal-head { display: flex; justify-content: space-between; align-items: center; font-size: 11px;
        color: var(--ink3); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 8px; }
      .axw-refresh { border: none; background: transparent; color: var(--ink3); font-size: 14px; }
      .axw-bal-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .axw-bal-row { display: flex; flex-direction: column; gap: 2px; padding: 8px; border: 1px solid var(--line);
        border-radius: 8px; background: var(--vocs-background-color-primary); }
      .axw-bal-l { font-size: 10px; color: var(--ink3); }
      .axw-bal-v { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }

      .axw-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .axw-tile { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 14px 6px;
        border: 1px solid var(--line); border-radius: 10px; background: var(--soft); color: var(--ink2);
        font-size: 12px; font-weight: 600; text-decoration: none; }
      .axw-tile:hover { color: var(--ink); border-color: var(--a); }
      .axw-tile-i { font-size: 20px; }
      .axw-mine { height: clamp(460px, 70vh, 620px); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }

      .axw-seg { display: flex; align-items: center; gap: 6px; }
      .axw-seg-btn { padding: 7px 14px; border-radius: 7px; font-size: 12px; font-weight: 600;
        border: 1px solid var(--line); background: transparent; color: var(--ink3); }
      .axw-seg-btn.axw-on { background: var(--a); color: #04130a; border-color: var(--a); }
      .axw-seg-note { font-size: 10px; color: var(--ink3); margin-left: auto; }

      .axw-recv-label { font-size: 10.5px; color: var(--ink3); }
      .axw-qr { display: flex; justify-content: center; padding: 14px; background: #fff; border-radius: 10px; }
      .axw-qr svg { width: 168px; height: 168px; display: block; }
      .axw-recv-addr { border: 1px solid var(--line); border-radius: 8px; padding: 12px; font-size: 12.5px;
        word-break: break-all; background: var(--soft); font-variant-numeric: tabular-nums; }

      .axw-err { font-size: 11px; color: var(--sell); word-break: break-word; }
      .axw-ok { font-size: 11.5px; color: var(--a); text-decoration: none; }
      .axw-foot { font-size: 10px; line-height: 1.5; color: var(--ink3); }
    `}</style>
  );
}
