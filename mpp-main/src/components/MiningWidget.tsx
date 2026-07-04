"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AxisGatewayClient,
  buildSubmission,
  commit,
  epochForMinted,
  gatewayUrl,
  getWorkType,
  MINING,
  type MiningWallet,
  type NetworkStats,
  SIM_DIFFICULTY,
  SIM_SEED_MINTED,
  shortAddress,
  simulatedNetworkStats,
  simulateQuality,
  simulateReward,
  telegramBotUrl,
  WORK_TYPES,
  walletFromSecret,
} from "../lib/axis";
import { deriveChallenge, solveChallenge } from "../lib/challenge";
import {
  buildMiningPrompt,
  DEFAULT_MODEL,
  type LlmConfig,
  type LlmProvider,
  loadLlmConfig,
  PROVIDER_LABEL,
  runInference,
  saveLlmConfig,
} from "../lib/llm";
import { AnalyticsEvents, captureEvent } from "../lib/posthog";
import {
  clearVault,
  freshWallet,
  hasVault,
  loadLegacy,
  saveEncrypted,
  unlock,
  vaultAddress,
} from "../lib/wallet-store";
import { WorkIcon } from "./WorkIcons";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LogStatus = "pending" | "approved" | "rejected";

type LogEntry = {
  id: string;
  work: string;
  workId: string;
  status: LogStatus;
  quality?: number;
  reward?: number;
  ts: number;
};

const AUTO = "auto";
const MAX_LOG = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// MiningWidget — an in-browser AXIS Proof-of-AI-Work miner.
// ---------------------------------------------------------------------------

export function MiningWidget({ className }: { className?: string }) {
  const [wallet, setWallet] = useState<MiningWallet | null>(null);
  const [mining, setMining] = useState(false);
  const [selected, setSelected] = useState<string>(AUTO);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [balance, setBalance] = useState(0);
  const [blocks, setBlocks] = useState(0);
  const [accepted, setAccepted] = useState(0);
  const [submitted, setSubmitted] = useState(0);
  const [stats, setStats] = useState<NetworkStats | null>(null);
  const [copied, setCopied] = useState(false);

  // Encrypted-vault wallet UX (self-custodial, password-encrypted at rest).
  const [locked, setLocked] = useState(false); // vault exists, awaiting unlock
  const [unsaved, setUnsaved] = useState(false); // in-memory wallet not yet encrypted
  const [lockedAddr, setLockedAddr] = useState<string | null>(null);
  const [showSeed, setShowSeed] = useState(false);
  const [seedCopied, setSeedCopied] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importDraft, setImportDraft] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  // Password flow (set/unlock).
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

  // On-chain AXIS held by this wallet (mined + bought on the market). Live only.
  const [walletAxis, setWalletAxis] = useState<string | null>(null);

  // AI inference provider (ChatGPT / Claude). When connected, the miner runs
  // real text inference for the `inference_text` work type.
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showAi, setShowAi] = useState(false);
  const [draftProvider, setDraftProvider] = useState<LlmProvider>("openai");
  const [draftKey, setDraftKey] = useState("");
  const [draftModel, setDraftModel] = useState(DEFAULT_MODEL.openai);
  const llmRef = useRef<LlmConfig | null>(null);

  const liveUrl = gatewayUrl();
  const isLive = Boolean(liveUrl);
  const tgUrl = telegramBotUrl();

  const runningRef = useRef(false);
  const mintedRef = useRef(SIM_SEED_MINTED);
  const selectedRef = useRef(selected);
  const walletRef = useRef<MiningWallet | null>(null);
  const statsRef = useRef<NetworkStats | null>(null);
  const clientRef = useRef<AxisGatewayClient | null>(
    liveUrl ? new AxisGatewayClient(liveUrl) : null,
  );

  selectedRef.current = selected;
  statsRef.current = stats;
  llmRef.current = llm;

  // Load a previously-saved AI provider config (browser-only).
  useEffect(() => {
    const saved = loadLlmConfig();
    if (saved) {
      setLlm(saved);
      setDraftProvider(saved.provider);
      setDraftModel(saved.model);
    }
  }, []);

  const connectAi = useCallback(() => {
    const key = draftKey.trim();
    if (!key) return;
    const cfg: LlmConfig = {
      provider: draftProvider,
      apiKey: key,
      model: draftModel.trim() || DEFAULT_MODEL[draftProvider],
    };
    setLlm(cfg);
    saveLlmConfig(cfg);
    setAiError(null);
    setDraftKey("");
    setShowAi(false);
    captureEvent(AnalyticsEvents.MINE_WORK_TYPE_SELECTED, {
      ai_provider: cfg.provider,
    });
  }, [draftProvider, draftKey, draftModel]);

  const disconnectAi = useCallback(() => {
    setLlm(null);
    saveLlmConfig(null);
    setAiError(null);
  }, []);

  // Resets the per-session mining counters when the active wallet changes.
  const resetSession = useCallback(() => {
    setBalance(0);
    setBlocks(0);
    setAccepted(0);
    setSubmitted(0);
    setLog([]);
  }, []);

  // Reads the wallet's authoritative on-chain AXIS balance (everything it ever
  // mined or bought on the market) via the gateway. Live mode only.
  const refreshBalance = useCallback(async () => {
    const c = clientRef.current;
    const w = walletRef.current;
    if (!c || !w) return;
    try {
      const r = await c.miner(w);
      const b = (r.body ?? {}) as {
        on_chain_balance_axis?: string | number;
        total_axis_earned?: string | number;
      };
      const v = b.on_chain_balance_axis ?? b.total_axis_earned;
      if (v != null) setWalletAxis(String(v));
    } catch {
      /* best-effort — leave the prior value */
    }
  }, []);

  // --- Wallet bootstrap ---------------------------------------------------
  // Generate a fresh in-memory seed wallet (not persisted until encrypted).
  const newWallet = useCallback(() => {
    const w = freshWallet();
    walletRef.current = w;
    setWallet(w);
    setLocked(false);
    setUnsaved(true);
    setShowSeed(false);
    setPw("");
    setPw2("");
    setPwError(null);
    setWalletAxis(null);
    resetSession();
    void refreshBalance();
    captureEvent(AnalyticsEvents.MINE_WALLET_GENERATED, {
      live: Boolean(liveUrl),
    });
  }, [liveUrl, resetSession, refreshBalance]);

  // Import an existing wallet from a seed phrase or 0x private key (e.g. a key
  // exported from the AXIS Telegram bot). It's held in memory; set a password
  // to encrypt + save it.
  const importWallet = useCallback(() => {
    const w = walletFromSecret(importDraft);
    if (!w) {
      setImportError("Enter a valid 12-word seed phrase or 0x private key.");
      return;
    }
    walletRef.current = w;
    setWallet(w);
    setLocked(false);
    setUnsaved(true);
    setImportDraft("");
    setImportError(null);
    setImportOpen(false);
    setShowSeed(false);
    setWalletAxis(null);
    resetSession();
    void refreshBalance();
    captureEvent(AnalyticsEvents.MINE_WALLET_GENERATED, {
      live: Boolean(liveUrl),
      imported: true,
    });
  }, [importDraft, liveUrl, resetSession, refreshBalance]);

  // Unlock the encrypted vault with the password.
  const unlockWallet = useCallback(async () => {
    setPwBusy(true);
    setPwError(null);
    const w = await unlock(pw);
    setPwBusy(false);
    if (!w) {
      setPwError("Wrong password — try again.");
      return;
    }
    walletRef.current = w;
    setWallet(w);
    setLocked(false);
    setUnsaved(false);
    setPw("");
    void refreshBalance();
  }, [pw, refreshBalance]);

  // Encrypt the in-memory wallet under a password and persist it.
  const secureWallet = useCallback(async () => {
    const w = walletRef.current;
    if (!w) return;
    if (pw.length < 10) {
      setPwError("Use at least 10 characters — this encrypts your wallet.");
      return;
    }
    if (pw !== pw2) {
      setPwError("Passwords don't match.");
      return;
    }
    setPwBusy(true);
    await saveEncrypted(w, pw);
    setPwBusy(false);
    setUnsaved(false);
    setPw("");
    setPw2("");
    setPwError(null);
  }, [pw, pw2]);

  // Wipe the saved wallet from this browser.
  const forgetWallet = useCallback(() => {
    clearVault();
    walletRef.current = null;
    setWallet(null);
    setLocked(false);
    setUnsaved(false);
    setWalletAxis(null);
    newWallet();
  }, [newWallet]);

  const copySeed = useCallback(() => {
    const m = walletRef.current?.mnemonic;
    if (!m) return;
    navigator.clipboard?.writeText(m).then(() => {
      setSeedCopied(true);
      setTimeout(() => setSeedCopied(false), 1400);
    });
  }, []);

  useEffect(() => {
    // If an encrypted vault exists, stay locked until the user unlocks it;
    // otherwise migrate a legacy plaintext wallet or create a fresh in-memory
    // one (held in memory until the user sets a password to encrypt + save it).
    let w: MiningWallet | null = null;
    if (hasVault()) {
      setLocked(true);
      setLockedAddr(vaultAddress());
    } else {
      w = loadLegacy() ?? freshWallet();
      walletRef.current = w;
      setWallet(w);
      setUnsaved(true);
    }
    // Open the import panel when arriving from a "connect" deep link
    // (e.g. the Telegram bot's web link).
    try {
      const params = new URLSearchParams(window.location.search);
      if (
        params.get("import") === "1" ||
        params.get("connect") === "telegram"
      ) {
        setImportOpen(true);
      }
    } catch {
      /* SSR / no window */
    }
    // Seed network state. Live stats need a signed read, so only when unlocked.
    if (clientRef.current && w) {
      clientRef.current
        .networkStats(w)
        .then((r) => r.body && setStats(r.body))
        .catch(() => setStats(simulatedNetworkStats(mintedRef.current)));
      void refreshBalance();
    } else {
      setStats(simulatedNetworkStats(mintedRef.current));
    }
    return () => {
      runningRef.current = false;
    };
    // refreshBalance is a stable useCallback, so this still runs once on mount
    // to restore/create the wallet and seed network state.
  }, [refreshBalance]);

  const pushLog = useCallback((entry: LogEntry) => {
    setLog((prev) => [entry, ...prev].slice(0, MAX_LOG));
  }, []);

  const updateLog = useCallback((id: string, patch: Partial<LogEntry>) => {
    setLog((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  // --- Single mining round ------------------------------------------------
  const mineOnce = useCallback(async () => {
    const w = walletRef.current;
    if (!w) return;

    const id =
      selectedRef.current === AUTO
        ? WORK_TYPES[Math.floor(Math.random() * WORK_TYPES.length)].id
        : selectedRef.current;
    const wt = getWorkType(id);
    if (!wt) return;

    const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    // Real AI inference for the text work type when a provider is connected.
    const aiCfg = id === "inference_text" ? llmRef.current : null;
    pushLog({
      id: localId,
      work: aiCfg
        ? `${wt.label} · ${PROVIDER_LABEL[aiCfg.provider].split(" ")[0]}`
        : wt.label,
      workId: id,
      status: "pending",
      ts: Date.now(),
    });
    setSubmitted((n) => n + 1);

    let output: string;
    // When set, buildSubmission commits this exact input_hash — required so the
    // engine re-derives the same answer-key challenge (see lib/challenge.ts).
    let inputSeed: string | undefined;
    if (aiCfg) {
      try {
        const prompt = buildMiningPrompt();
        const text = await runInference(aiCfg, prompt);
        // Include the prompt so the engine scores relevance against the actual
        // task (prompt-conditioned), not just resemblance to a fixed corpus.
        output = JSON.stringify({ text, prompt });
        setAiError(null);
      } catch (e) {
        // Surface the error but keep mining with a sample so the loop survives.
        setAiError(e instanceof Error ? e.message : "AI request failed");
        output = wt.sample();
      }
    } else if (id === "inference_text") {
      // No API key: do real, verifiable answer-key work instead of a canned
      // sample. The challenge is derived from this submission's input_hash; the
      // engine re-derives it and grades the answer — no OpenAI/Anthropic needed.
      inputSeed = `challenge:${id}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const challenge = deriveChallenge(commit(inputSeed));
      output = JSON.stringify({
        mode: "challenge",
        answer: solveChallenge(challenge),
      });
    } else {
      output = wt.sample();
    }

    const live = statsRef.current;
    const base = Number(
      live?.base_reward_axis ?? epochForMinted(mintedRef.current).baseReward,
    );
    const difficulty = live?.difficulty ?? SIM_DIFFICULTY;

    try {
      const body = await buildSubmission(w, id, output, {
        channel: "web",
        inputSeed,
      });

      if (clientRef.current) {
        // ---- Live gateway path ----
        const res = await clientRef.current.submit(body);
        if (res.status === 429) {
          updateLog(localId, { status: "rejected" });
          await sleep((res.body.retry_after_seconds ?? 2) * 1000);
          return;
        }
        const jobId = res.body.job_id;
        if (!jobId) {
          updateLog(localId, { status: "rejected" });
          return;
        }
        let final: { status?: string; reward?: string; quality?: number } = {};
        for (let i = 0; i < 12; i++) {
          await sleep(1200);
          if (!runningRef.current) break;
          const st = await clientRef.current.status(w, jobId);
          final = st.body;
          if (
            ["approved", "rejected", "error"].includes(String(st.body.status))
          )
            break;
        }
        if (final.status === "approved") {
          const reward = Number(final.reward ?? 0);
          const quality = Number(final.quality ?? 0);
          updateLog(localId, { status: "approved", reward, quality });
          setBalance((b) => b + reward);
          setBlocks((n) => n + 1);
          setAccepted((n) => n + 1);
          mintedRef.current += reward;
          void refreshBalance();
          captureEvent(AnalyticsEvents.MINE_BLOCK_FOUND, {
            work_type: id,
            reward,
            live: true,
          });
        } else {
          updateLog(localId, {
            status: "rejected",
            quality: Number(final.quality ?? 0),
          });
        }
      } else {
        // ---- Simulation path ----
        await sleep(
          MINING.simMinLatencyMs +
            Math.random() * (MINING.simMaxLatencyMs - MINING.simMinLatencyMs),
        );
        const quality = simulateQuality(id);
        const approved = quality >= 0.5;
        const reward = approved
          ? simulateReward(base, id, quality, difficulty)
          : 0;
        if (approved) {
          updateLog(localId, { status: "approved", quality, reward });
          setBalance((b) => b + reward);
          setBlocks((n) => n + 1);
          setAccepted((n) => n + 1);
          mintedRef.current += reward;
          setStats(simulatedNetworkStats(mintedRef.current));
          captureEvent(AnalyticsEvents.MINE_BLOCK_FOUND, {
            work_type: id,
            reward,
            live: false,
          });
        } else {
          updateLog(localId, { status: "rejected", quality });
        }
      }
    } catch {
      updateLog(localId, { status: "rejected" });
    }
  }, [pushLog, updateLog, refreshBalance]);

  // --- Mining loop --------------------------------------------------------
  // A single worker: mine, brief pause, repeat until stopped. Several of these
  // run concurrently for aggressive throughput.
  const worker = useCallback(async () => {
    while (runningRef.current) {
      await mineOnce();
      if (!runningRef.current) break;
      await sleep(
        MINING.minDelayMs +
          Math.random() * (MINING.maxDelayMs - MINING.minDelayMs),
      );
    }
  }, [mineOnce]);

  const toggleMining = useCallback(() => {
    setMining((on) => {
      const next = !on;
      runningRef.current = next;
      if (next) {
        // Throttle to a single worker when a real AI provider is connected so
        // we don't fan out paid API calls; otherwise mine aggressively.
        const concurrency = llmRef.current ? 1 : MINING.concurrency;
        captureEvent(AnalyticsEvents.MINE_STARTED, {
          live: isLive,
          work_type: selectedRef.current,
          concurrency,
        });
        // Fan out concurrent workers, staggered slightly so submissions don't
        // all land in the same instant.
        for (let i = 0; i < concurrency; i++) {
          const startDelay = i * 90;
          void (async () => {
            await sleep(startDelay);
            if (runningRef.current) await worker();
          })();
        }
      } else {
        captureEvent(AnalyticsEvents.MINE_STOPPED, { live: isLive });
      }
      return next;
    });
  }, [isLive, worker]);

  const copyAddress = useCallback(() => {
    const addr = wallet?.address ?? lockedAddr;
    if (!addr) return;
    navigator.clipboard?.writeText(addr).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [wallet, lockedAddr]);

  const acceptRate =
    submitted > 0 ? Math.round((accepted / submitted) * 100) : 100;

  // Automatic post-Genesis (>25% supply) difficulty multiplier, for display.
  const supplyMult = stats?.supply_difficulty_multiplier ?? 1;
  const ramping = supplyMult > 1.001;

  return (
    <div className={`axm ${className ?? ""}`}>
      <Styles />

      {/* Title bar */}
      <div className="axm-bar">
        <div className="axm-dots">
          <span /> <span /> <span />
        </div>
        <div className="axm-title">axis-miner</div>
        <div className={`axm-mode ${isLive ? "axm-live" : "axm-sim"}`}>
          <span className="axm-mode-dot" />
          {isLive ? "LIVE" : "SIMULATED"}
        </div>
      </div>

      <div className="axm-body">
        {/* Wallet row */}
        <div className="axm-wallet">
          <span className="axm-label">Mining wallet</span>
          <button
            type="button"
            className="axm-addr"
            onClick={copyAddress}
            title="Copy address"
          >
            {wallet
              ? shortAddress(wallet.address)
              : lockedAddr
                ? shortAddress(lockedAddr)
                : "deriving…"}
            <span className="axm-copy">
              {locked ? "🔒 locked" : copied ? "copied" : "copy"}
            </span>
          </button>
          {wallet?.mnemonic && (
            <button
              type="button"
              className="axm-regen"
              onClick={() => {
                setShowSeed((s) => !s);
                setImportOpen(false);
              }}
            >
              seed
            </button>
          )}
          {!locked && (
            <button
              type="button"
              className="axm-regen"
              onClick={() => {
                setImportOpen((s) => !s);
                setShowSeed(false);
                setImportError(null);
              }}
              disabled={mining}
              title="Log in with an existing seed phrase or key"
            >
              log in
            </button>
          )}
          {!locked && (
            <button
              type="button"
              className="axm-regen"
              onClick={newWallet}
              disabled={mining}
            >
              new
            </button>
          )}
        </div>

        {/* Unlock panel — an encrypted wallet exists in this browser */}
        {locked && (
          <div className="axm-seed">
            <div className="axm-seed-h">
              🔒 This browser has an encrypted AXIS wallet. Enter your password
              to unlock it and mine.
            </div>
            <div className="axm-ai-row2">
              <input
                className="axm-ai-input"
                type="password"
                placeholder="Wallet password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void unlockWallet()}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="axm-ai-connect"
                onClick={() => void unlockWallet()}
                disabled={pwBusy || !pw}
              >
                {pwBusy ? "…" : "Unlock"}
              </button>
            </div>
            {pwError && <div className="axm-ai-err">{pwError}</div>}
            <div className="axm-ai-note">
              Forgot it? There's no recovery — restore from your 12-word seed
              instead:{" "}
              <button
                type="button"
                className="axm-linkbtn"
                onClick={() => {
                  setLocked(false);
                  setImportOpen(true);
                  setPwError(null);
                }}
              >
                log in with seed
              </button>
              .
            </div>
          </div>
        )}

        {/* Secure panel — an in-memory wallet that isn't encrypted/saved yet */}
        {unsaved && wallet && (
          <div className="axm-seed">
            <div className="axm-seed-warn">
              🔐 Set a password to encrypt this wallet and save it in this
              browser. Until you do, it won't survive a refresh — so back up the
              seed too. Your password and seed never leave your device.
            </div>
            <input
              className="axm-ai-input"
              type="password"
              placeholder="New password (min 10 chars)"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoComplete="new-password"
            />
            <div className="axm-ai-row2">
              <input
                className="axm-ai-input"
                type="password"
                placeholder="Confirm password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void secureWallet()}
                autoComplete="new-password"
              />
              <button
                type="button"
                className="axm-ai-connect"
                onClick={() => void secureWallet()}
                disabled={pwBusy || !pw}
              >
                {pwBusy ? "…" : "Encrypt & save"}
              </button>
            </div>
            {pwError && <div className="axm-ai-err">{pwError}</div>}
          </div>
        )}

        {/* Seed backup panel */}
        {showSeed && wallet?.mnemonic && (
          <div className="axm-seed">
            <div className="axm-seed-warn">
              ⚠ Your 12-word seed controls this wallet and all its AXIS. Write
              it down and keep it private. Anyone with these words can take your
              rewards — AXIS can never recover them for you.
            </div>
            <div className="axm-seed-words">
              {wallet.mnemonic.split(" ").map((word, i) => (
                // Static, never-reordered list; a positional key is correct here.
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-order seed words
                <span key={`${i}-${word}`} className="axm-seed-word">
                  <span className="axm-seed-num">{i + 1}</span>
                  {word}
                </span>
              ))}
            </div>
            <div className="axm-seed-actions">
              <button type="button" className="axm-regen" onClick={copySeed}>
                {seedCopied ? "copied" : "copy seed"}
              </button>
              <button
                type="button"
                className="axm-ai-connect"
                onClick={() => setShowSeed(false)}
              >
                Done
              </button>
              <button
                type="button"
                className="axm-regen"
                onClick={forgetWallet}
                disabled={mining}
                title="Wipe this wallet from the browser and start fresh"
              >
                forget
              </button>
            </div>
            <div className="axm-ai-note">
              Use the same words in the terminal miner (
              <code>node bin/axis-miner.mjs --seed "…"</code>) to mine to this
              exact wallet from anywhere.
            </div>
          </div>
        )}

        {/* Import panel */}
        {importOpen && (
          <div className="axm-seed">
            <div className="axm-seed-h">
              Log in to your wallet — paste your 12-word seed phrase (or a 0x
              private key, e.g. the one the AXIS Telegram bot gives you with{" "}
              <code>/export</code>) to restore it and see the AXIS you mined or
              bought. One wallet, one seed — across the miner, the market, the
              terminal and Telegram.
            </div>
            <textarea
              className="axm-import-input"
              placeholder="word1 word2 … word12   —or—   0x{64 hex}"
              value={importDraft}
              onChange={(e) => setImportDraft(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              rows={2}
            />
            <div className="axm-seed-actions">
              <button
                type="button"
                className="axm-ai-connect"
                onClick={importWallet}
                disabled={!importDraft.trim()}
              >
                Import wallet
              </button>
              <button
                type="button"
                className="axm-regen"
                onClick={() => {
                  setImportOpen(false);
                  setImportDraft("");
                  setImportError(null);
                }}
              >
                cancel
              </button>
            </div>
            {importError && <div className="axm-ai-err">{importError}</div>}
            <div className="axm-ai-note">
              {tgUrl && (
                <>
                  Mining on Telegram? Send <code>/export</code> to{" "}
                  <a href={tgUrl} target="_blank" rel="noreferrer">
                    the AXIS bot
                  </a>{" "}
                  and paste the key above to share one balance.{" "}
                </>
              )}
              The secret is processed only in this browser and saved locally —
              it is never sent to AXIS.
            </div>
          </div>
        )}

        {/* Work types */}
        <div className="axm-works">
          <button
            type="button"
            className={`axm-chip ${selected === AUTO ? "axm-chip-on" : ""}`}
            onClick={() => {
              setSelected(AUTO);
              captureEvent(AnalyticsEvents.MINE_WORK_TYPE_SELECTED, {
                work_type: AUTO,
              });
            }}
          >
            <span className="axm-chip-auto" /> Auto
          </button>
          {WORK_TYPES.map((w) => (
            <button
              key={w.id}
              type="button"
              className={`axm-chip ${selected === w.id ? "axm-chip-on" : ""}`}
              onClick={() => {
                setSelected(w.id);
                captureEvent(AnalyticsEvents.MINE_WORK_TYPE_SELECTED, {
                  work_type: w.id,
                });
              }}
              title={w.instructions}
            >
              <WorkIcon id={w.id} size={13} />
              {w.label}
            </button>
          ))}
        </div>

        {/* AI inference provider */}
        <div className="axm-ai">
          <div className="axm-ai-head">
            <span className="axm-label">AI inference</span>
            {llm ? (
              <span className="axm-ai-status axm-ai-on">
                <span className="axm-ai-dot" />
                {PROVIDER_LABEL[llm.provider]} · {llm.model}
              </span>
            ) : (
              <span className="axm-ai-status">
                not connected — submitting samples
              </span>
            )}
            <button
              type="button"
              className="axm-regen"
              onClick={() => setShowAi((s) => !s)}
            >
              {llm ? "change" : "connect API key"}
            </button>
            {llm && (
              <button
                type="button"
                className="axm-regen"
                onClick={disconnectAi}
              >
                disconnect
              </button>
            )}
          </div>

          {showAi && (
            <div className="axm-ai-form">
              <div className="axm-ai-providers">
                {(["openai", "anthropic"] as LlmProvider[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`axm-chip ${draftProvider === p ? "axm-chip-on" : ""}`}
                    onClick={() => {
                      setDraftProvider(p);
                      setDraftModel(DEFAULT_MODEL[p]);
                    }}
                  >
                    {PROVIDER_LABEL[p]}
                  </button>
                ))}
              </div>
              <input
                className="axm-ai-input"
                type="password"
                placeholder={
                  draftProvider === "openai"
                    ? "OpenAI API key (sk-…)"
                    : "Anthropic API key (sk-ant-…)"
                }
                value={draftKey}
                onChange={(e) => setDraftKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <div className="axm-ai-row2">
                <input
                  className="axm-ai-input axm-ai-model"
                  type="text"
                  placeholder="model"
                  value={draftModel}
                  onChange={(e) => setDraftModel(e.target.value)}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="axm-ai-connect"
                  onClick={connectAi}
                  disabled={!draftKey.trim()}
                >
                  Connect
                </button>
              </div>
              <div className="axm-ai-note">
                Your key is stored only in this browser and sent directly to{" "}
                {PROVIDER_LABEL[draftProvider].split(" ")[0]} — AXIS never sees
                it. Text-inference blocks run real AI on your account.
              </div>
            </div>
          )}

          {aiError && <div className="axm-ai-err">AI error: {aiError}</div>}
        </div>

        {/* Action + stats */}
        <div className="axm-action-row">
          <button
            type="button"
            className={`axm-mine-btn ${mining ? "axm-mining" : ""}`}
            onClick={toggleMining}
            disabled={locked || !wallet}
          >
            <span className="axm-btn-ind" />
            {locked
              ? "Unlock to mine"
              : mining
                ? "Stop mining"
                : "Start mining"}
          </button>
          <div className="axm-balance">
            <div className="axm-balance-main">
              <span className="axm-balance-val">
                {(isLive && walletAxis != null
                  ? Number(walletAxis)
                  : balance
                ).toFixed(4)}
              </span>
              <span className="axm-balance-unit">AXIS</span>
            </div>
            <div className="axm-balance-cap">
              {isLive && walletAxis != null
                ? "wallet · mined + bought"
                : "this session"}
            </div>
          </div>
        </div>

        <div className="axm-stats">
          <Stat label="Blocks" value={String(blocks)} />
          <Stat label="Accept rate" value={`${acceptRate}%`} />
          <Stat
            label={
              ramping ? `Difficulty ·${supplyMult.toFixed(1)}×` : "Difficulty"
            }
            value={stats?.difficulty != null ? String(stats.difficulty) : "—"}
          />
          <Stat label="Epoch" value={stats?.epoch ?? "—"} />
          <Stat
            label="Base reward"
            value={stats?.base_reward_axis ? `${stats.base_reward_axis}` : "—"}
          />
          <Stat
            label="Supply mined"
            value={
              stats?.percent_of_supply_mined != null
                ? `${stats.percent_of_supply_mined.toFixed(2)}%`
                : "—"
            }
          />
        </div>

        {/* Live submission log */}
        <div className="axm-log">
          {log.length === 0 ? (
            <div className="axm-log-empty">
              Press <b>Start mining</b> to submit verifiable AI work and earn
              AXIS.
            </div>
          ) : (
            log.map((e) => (
              <div key={e.id} className={`axm-log-row axm-${e.status}`}>
                <span className="axm-log-icon">
                  <WorkIcon id={e.workId} size={13} />
                </span>
                <span className="axm-log-work">{e.work}</span>
                <span className="axm-log-status">
                  {e.status === "pending"
                    ? "verifying…"
                    : e.status === "approved"
                      ? `Q ${(e.quality ?? 0).toFixed(2)}`
                      : "rejected"}
                </span>
                <span className="axm-log-reward">
                  {e.status === "approved" && e.reward != null
                    ? `+${e.reward.toFixed(4)} AXIS`
                    : e.status === "pending"
                      ? "···"
                      : "—"}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="axm-stat">
      <div className="axm-stat-val">{value}</div>
      <div className="axm-stat-label">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scoped styles — tuned to the Vocs theme tokens used across the site.
// ---------------------------------------------------------------------------

function Styles() {
  return (
    <style>{`
      .axm {
        --axm-line: light-dark(rgba(9,9,11,0.10), rgba(255,255,255,0.09));
        --axm-soft: light-dark(rgba(9,9,11,0.028), rgba(255,255,255,0.03));
        --axm-lime: #eef2f9;
        --axm-lime-ink: light-dark(#1f9d63, #7fe0a8);
        --axm-ink: var(--vocs-text-color-heading);
        --axm-ink2: var(--vocs-text-color-secondary);
        --axm-ink3: var(--vocs-text-color-muted);
        position: relative;
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        overflow: hidden;
        background: light-dark(#ffffff, #101217);
        font-family: var(--font-mono, "Geist Mono", monospace);
        color: var(--axm-ink);
      }
      .axm-bar {
        display: flex; align-items: center; gap: 0.6rem;
        padding: 0.55rem 0.9rem;
        border-bottom: 1px solid var(--axm-line);
        flex-shrink: 0;
      }
      .axm-dots { display: flex; align-items: center; }
      .axm-dots span { width: 7px; height: 7px; border-radius: 50%; background: var(--axm-lime-ink); box-shadow: 0 0 7px var(--axm-lime-ink); }
      .axm-dots span:not(:first-child) { display: none; }
      .axm-title { font-size: 11.5px; color: var(--axm-ink3); letter-spacing: 0.1em; text-transform: uppercase; }
      .axm-mode {
        margin-left: auto; display: flex; align-items: center; gap: 6px;
        font-size: 9.5px; letter-spacing: 0.14em; padding: 2px 9px; border-radius: 999px;
        border: 1px solid var(--axm-line); color: var(--axm-ink3);
      }
      .axm-mode-dot { width: 6px; height: 6px; border-radius: 50%; }
      .axm-live .axm-mode-dot { background: var(--axm-lime-ink); box-shadow: 0 0 7px var(--axm-lime-ink); }
      .axm-sim .axm-mode-dot { background: var(--axm-ink3); }

      /* Scrolls internally so the mine button + log are always reachable even
         when the panel is shorter than the miner (tall AI form / seed backup). */
      .axm-body { display: flex; flex-direction: column; gap: 0.7rem; padding: 0.9rem; flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
      .axm-body > * { flex-shrink: 0; }

      .axm-wallet { display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; }
      .axm-label { font-size: 10px; color: var(--axm-ink3); text-transform: uppercase; letter-spacing: 0.1em; }
      .axm-addr {
        display: inline-flex; align-items: center; gap: 0.5rem;
        font-size: 12.5px; padding: 3px 9px; border-radius: 6px;
        border: 1px solid var(--axm-line); background: var(--axm-soft);
        color: var(--axm-ink); cursor: pointer; transition: border-color .15s ease;
      }
      .axm-addr:hover { border-color: var(--axm-ink3); }
      .axm-copy { font-size: 8.5px; color: var(--axm-ink3); text-transform: uppercase; letter-spacing: 0.1em; }
      .axm-regen {
        font-size: 10.5px; padding: 3px 9px; border-radius: 6px; cursor: pointer;
        border: 1px solid var(--axm-line); background: transparent; color: var(--axm-ink3); transition: border-color .15s ease, color .15s ease;
      }
      .axm-regen:hover:not(:disabled) { color: var(--axm-ink2); border-color: var(--axm-ink3); }
      .axm-regen:disabled { opacity: 0.4; cursor: not-allowed; }
      .axm-regen-warn { color: light-dark(#b08400, #e0c54a); border-color: light-dark(#d8b400, #6b5e1d); display: inline-flex; align-items: center; gap: 5px; }
      .axm-warn-dot { width: 6px; height: 6px; border-radius: 50%; background: light-dark(#d8a400, #e0c54a); box-shadow: 0 0 6px light-dark(#d8a400, #e0c54a); }

      .axm-seed { display: flex; flex-direction: column; gap: 8px; padding: 10px; border: 1px solid var(--axm-line); border-radius: 8px; background: var(--axm-soft); }
      .axm-seed-h { font-size: 11px; line-height: 1.5; color: var(--axm-ink2); }
      .axm-seed-h code, .axm-ai-note code { font-size: 10.5px; padding: 1px 4px; border-radius: 4px; background: light-dark(rgba(9,9,11,0.06), rgba(255,255,255,0.07)); }
      .axm-seed-warn { font-size: 10.5px; line-height: 1.55; color: light-dark(#a3362f, #f0a59c); padding: 7px 9px; border-radius: 6px; border: 1px solid light-dark(rgba(192,54,47,0.30), rgba(240,133,125,0.28)); background: light-dark(rgba(192,54,47,0.05), rgba(240,133,125,0.06)); }
      .axm-seed-words { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
      .axm-seed-word { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--axm-line); background: var(--vocs-background-color-primary); color: var(--axm-ink); }
      .axm-seed-num { font-size: 9px; color: var(--axm-ink3); min-width: 12px; font-variant-numeric: tabular-nums; }
      .axm-seed-actions { display: flex; gap: 7px; align-items: center; }
      .axm-import-input { width: 100%; box-sizing: border-box; resize: vertical; font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.5; padding: 7px 9px; border-radius: 6px; border: 1px solid var(--axm-line); background: var(--vocs-background-color-primary); color: var(--axm-ink); }
      .axm-import-input::placeholder { color: var(--axm-ink3); }
      .axm-import-input:focus { outline: none; border-color: var(--axm-lime-ink); }

      @media (max-width: 520px) {
        .axm-seed-words { grid-template-columns: repeat(2, 1fr); }
      }

      .axm-works { display: flex; flex-wrap: wrap; gap: 5px; }
      .axm-chip {
        display: inline-flex; align-items: center; gap: 5px;
        font-size: 11px; padding: 4px 9px 4px 7px; border-radius: 7px; cursor: pointer;
        border: 1px solid var(--axm-line); background: transparent; color: var(--axm-ink2);
        transition: border-color .15s ease, color .15s ease, background .15s ease;
      }
      .axm-chip svg { color: var(--axm-ink3); }
      .axm-chip:hover { border-color: var(--axm-ink3); color: var(--axm-ink); }
      .axm-chip:hover svg { color: var(--axm-lime-ink); }
      .axm-chip-on { background: var(--axm-lime); color: #0a0c10; border-color: var(--axm-lime); font-weight: 600; }
      .axm-chip-on svg { color: #0a0c10; }
      .axm-chip-auto { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid currentColor; box-sizing: border-box; }
      .axm-chip-on .axm-chip-auto { border-color: #0a0c10; }

      .axm-ai { display: flex; flex-direction: column; gap: 6px; }
      .axm-ai-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .axm-ai-status { font-size: 10.5px; color: var(--axm-ink3); display: inline-flex; align-items: center; gap: 6px; margin-right: auto; }
      .axm-ai-status.axm-ai-on { color: var(--axm-ink2); }
      .axm-ai-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--axm-lime-ink); box-shadow: 0 0 7px var(--axm-lime-ink); }
      .axm-ai-form { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--axm-line); border-radius: 8px; background: var(--axm-soft); }
      .axm-ai-providers { display: flex; gap: 5px; flex-wrap: wrap; }
      .axm-ai-input { width: 100%; box-sizing: border-box; font-family: var(--font-mono, monospace); font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--axm-line); background: var(--vocs-background-color-primary); color: var(--axm-ink); }
      .axm-ai-input::placeholder { color: var(--axm-ink3); }
      .axm-ai-input:focus { outline: none; border-color: var(--axm-lime-ink); }
      .axm-ai-row2 { display: flex; gap: 6px; }
      .axm-ai-model { flex: 1; }
      .axm-ai-connect { padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid var(--axm-lime); background: var(--axm-lime); color: #0a0c10; white-space: nowrap; }
      .axm-ai-connect:disabled { opacity: 0.4; cursor: not-allowed; }
      .axm-ai-note { font-size: 9.5px; line-height: 1.5; color: var(--axm-ink3); }
      .axm-ai-err { font-size: 10px; color: light-dark(#b91c1c, #f0857d); }

      .axm-action-row { display: flex; align-items: center; gap: 0.8rem; }
      .axm-mine-btn {
        flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.55rem;
        padding: 0.62rem 1rem; border-radius: 8px; cursor: pointer;
        font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em;
        border: 1px solid var(--axm-lime); background: var(--axm-lime); color: #0a0c10;
        transition: transform 0.15s ease, background 0.15s ease;
      }
      .axm-mine-btn:hover:not(:disabled) { transform: translateY(-1px); background: color-mix(in oklab, var(--axm-lime) 88%, #fff); }
      .axm-mine-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .axm-linkbtn { background: none; border: none; padding: 0; color: var(--axm-lime-ink); cursor: pointer; font: inherit; text-decoration: underline; }
      .axm-btn-ind { width: 7px; height: 7px; border-radius: 1px; background: #0a0c10; }
      .axm-mining { background: transparent; color: var(--axm-lime-ink); border-color: var(--axm-lime-ink); }
      .axm-mining .axm-btn-ind { background: var(--axm-lime-ink); animation: axmBlink 1.1s steps(2) infinite; }
      @keyframes axmBlink { 0%,100% { opacity: 1; } 50% { opacity: 0.2; } }

      .axm-balance { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; white-space: nowrap; }
      .axm-balance-main { display: flex; align-items: baseline; gap: 5px; }
      .axm-balance-cap { font-size: 8px; color: var(--axm-ink3); text-transform: uppercase; letter-spacing: 0.09em; }
      .axm-balance-val { font-size: 19px; font-weight: 600; color: var(--axm-ink); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
      .axm-balance-unit { font-size: 10px; color: var(--axm-lime-ink); letter-spacing: 0.06em; }

      .axm-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--axm-line); border: 1px solid var(--axm-line); border-radius: 8px; overflow: hidden; }
      .axm-stat { padding: 7px 9px; background: var(--vocs-background-color-primary); }
      .axm-stat-val { font-size: 13px; font-weight: 600; color: var(--axm-ink); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: -0.01em; }
      .axm-stat-label { font-size: 9px; color: var(--axm-ink3); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 3px; }

      .axm-log {
        flex: none; min-height: 110px; max-height: 240px; overflow-y: auto;
        border: 1px solid var(--axm-line); border-radius: 8px;
        background: light-dark(rgba(9,9,11,0.012), rgba(0,0,0,0.16));
      }
      .axm-log-empty { font-size: 11.5px; color: var(--axm-ink3); padding: 1.1rem 0.7rem; text-align: center; line-height: 1.6; }
      .axm-log-row {
        display: grid; grid-template-columns: 20px 1fr auto auto; align-items: center; gap: 9px;
        padding: 6px 10px; font-size: 11.5px;
        border-bottom: 1px solid var(--axm-soft);
        animation: axmFade 0.25s ease;
      }
      .axm-log-row:last-child { border-bottom: none; }
      @keyframes axmFade { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; } }
      .axm-log-icon { display: inline-flex; color: var(--axm-ink3); }
      .axm-log-work { color: var(--axm-ink2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .axm-log-status { font-size: 10px; color: var(--axm-ink3); letter-spacing: 0.02em; }
      .axm-log-reward { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--axm-ink3); }
      .axm-approved .axm-log-reward { color: var(--axm-lime-ink); font-weight: 600; }
      .axm-approved .axm-log-status { color: var(--axm-lime-ink); }
      .axm-approved .axm-log-icon { color: var(--axm-ink2); }
      .axm-pending { opacity: 0.7; }
      .axm-rejected { opacity: 0.5; }
      .axm-rejected .axm-log-status { color: light-dark(#b91c1c, #f0857d); }

      .axm-foot {
        flex-shrink: 0; padding: 0.55rem 0.9rem; font-size: 10px; line-height: 1.5;
        color: var(--axm-ink3); border-top: 1px solid var(--axm-line);
      }

      @media (max-width: 520px) {
        .axm-stats { grid-template-columns: repeat(2, 1fr); }
        .axm-balance-val { font-size: 17px; }
      }
    `}</style>
  );
}
