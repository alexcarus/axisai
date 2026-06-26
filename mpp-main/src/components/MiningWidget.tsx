"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AxisGatewayClient,
  buildSubmission,
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
  isBackedUp,
  loadOrCreateWallet,
  persistFresh,
  saveWallet,
  setBackedUp,
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

  // Seed/backup + import (self-custodial wallet UX).
  const [backedUp, setBackedUpState] = useState(true);
  const [showSeed, setShowSeed] = useState(false);
  const [seedCopied, setSeedCopied] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importDraft, setImportDraft] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

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
  // Generate a fresh, backup-able seed wallet (replacing the current one).
  const newWallet = useCallback(() => {
    const w = persistFresh();
    walletRef.current = w;
    setWallet(w);
    setBackedUpState(false);
    setShowSeed(false);
    setWalletAxis(null);
    resetSession();
    void refreshBalance();
    captureEvent(AnalyticsEvents.MINE_WALLET_GENERATED, {
      live: Boolean(liveUrl),
    });
  }, [liveUrl, resetSession, refreshBalance]);

  // Import an existing wallet from a seed phrase or 0x private key (e.g. a key
  // exported from the AXIS Telegram bot, or a seed backed up elsewhere).
  const importWallet = useCallback(() => {
    const w = walletFromSecret(importDraft);
    if (!w) {
      setImportError("Enter a valid 12-word seed phrase or 0x private key.");
      return;
    }
    walletRef.current = w;
    setWallet(w);
    saveWallet(w);
    setBackedUp(true); // the user already holds this secret elsewhere
    setBackedUpState(true);
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

  const confirmBackup = useCallback(() => {
    setBackedUp(true);
    setBackedUpState(true);
  }, []);

  const copySeed = useCallback(() => {
    const m = walletRef.current?.mnemonic;
    if (!m) return;
    navigator.clipboard?.writeText(m).then(() => {
      setSeedCopied(true);
      setTimeout(() => setSeedCopied(false), 1400);
    });
  }, []);

  useEffect(() => {
    // Restore the persisted self-custodial wallet, or create + persist a fresh
    // seed wallet on first visit.
    const w = loadOrCreateWallet();
    walletRef.current = w;
    setWallet(w);
    setBackedUpState(isBackedUp());
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
    // Seed network state.
    if (clientRef.current) {
      // Best-effort live stats; falls back silently to simulation seed.
      clientRef.current
        .networkStats(w)
        .then((r) => r.body && setStats(r.body))
        .catch(() => setStats(simulatedNetworkStats(mintedRef.current)));
      // Show the wallet's existing on-chain AXIS (what it mined or bought before).
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
    if (aiCfg) {
      try {
        const text = await runInference(aiCfg, buildMiningPrompt());
        output = JSON.stringify({ text });
        setAiError(null);
      } catch (e) {
        // Surface the error but keep mining with a sample so the loop survives.
        setAiError(e instanceof Error ? e.message : "AI request failed");
        output = wt.sample();
      }
    } else {
      output = wt.sample();
    }

    const live = statsRef.current;
    const base = Number(
      live?.base_reward_axis ?? epochForMinted(mintedRef.current).baseReward,
    );
    const difficulty = live?.difficulty ?? SIM_DIFFICULTY;

    try {
      const body = await buildSubmission(w, id, output, { channel: "web" });

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
    if (!wallet) return;
    navigator.clipboard?.writeText(wallet.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  }, [wallet]);

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
            {wallet ? shortAddress(wallet.address) : "deriving…"}
            <span className="axm-copy">{copied ? "copied" : "copy"}</span>
          </button>
          {wallet?.mnemonic && (
            <button
              type="button"
              className={`axm-regen ${!backedUp ? "axm-regen-warn" : ""}`}
              onClick={() => {
                setShowSeed((s) => !s);
                setImportOpen(false);
              }}
            >
              {!backedUp && <span className="axm-warn-dot" />}
              {backedUp ? "backup seed" : "back up seed"}
            </button>
          )}
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
          <button
            type="button"
            className="axm-regen"
            onClick={newWallet}
            disabled={mining}
          >
            new wallet
          </button>
        </div>

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
                onClick={() => {
                  confirmBackup();
                  setShowSeed(false);
                }}
              >
                I've saved it
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
          >
            <span className="axm-btn-ind" />
            {mining ? "Stop mining" : "Start mining"}
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

      <div className="axm-foot">
        {ramping
          ? `Past 25% of supply mined — difficulty is ramped ${supplyMult.toFixed(2)}× (toward 8× at the 84M cap), so each block is harder to earn. `
          : "Mining is easiest during the Genesis Phase (first 25% of supply); difficulty automatically ramps up to 8× afterwards. "}
        Your seed is self-custodial — it stays in this browser and is never sent
        to AXIS.{" "}
        {isLive
          ? "Connected to a live AXIS gateway: submissions are signed and verified on-chain."
          : "Demo mode: work is signed with the canonical AXIS scheme and scored locally. Set VITE_AXIS_GATEWAY_URL to mine against a live gateway."}
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
        --axm-lime: #cdf24e;
        --axm-lime-ink: light-dark(#3f6b15, #cdf24e);
        --axm-ink: var(--vocs-text-color-heading);
        --axm-ink2: var(--vocs-text-color-secondary);
        --axm-ink3: var(--vocs-text-color-muted);
        position: relative;
        display: flex;
        flex-direction: column;
        height: 100%;
        width: 100%;
        overflow: hidden;
        background: light-dark(rgba(255,255,255,0.35), rgba(255,255,255,0.012));
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
      .axm-dots span { width: 7px; height: 7px; border-radius: 50%; background: var(--axm-lime); box-shadow: 0 0 7px var(--axm-lime); }
      .axm-dots span:not(:first-child) { display: none; }
      .axm-title { font-size: 11.5px; color: var(--axm-ink3); letter-spacing: 0.1em; text-transform: uppercase; }
      .axm-mode {
        margin-left: auto; display: flex; align-items: center; gap: 6px;
        font-size: 9.5px; letter-spacing: 0.14em; padding: 2px 9px; border-radius: 999px;
        border: 1px solid var(--axm-line); color: var(--axm-ink3);
      }
      .axm-mode-dot { width: 6px; height: 6px; border-radius: 50%; }
      .axm-live .axm-mode-dot { background: var(--axm-lime); box-shadow: 0 0 7px var(--axm-lime); }
      .axm-sim .axm-mode-dot { background: light-dark(#b59000, #e0c54a); }

      .axm-body { display: flex; flex-direction: column; gap: 0.7rem; padding: 0.9rem; flex: 1; min-height: 0; }

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
      .axm-seed-warn { font-size: 10.5px; line-height: 1.55; color: light-dark(#8a5a00, #e6c965); padding: 7px 9px; border-radius: 6px; border: 1px solid light-dark(rgba(216,164,0,0.35), rgba(224,197,74,0.25)); background: light-dark(rgba(216,164,0,0.06), rgba(224,197,74,0.05)); }
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
      .axm-chip-on { background: var(--axm-lime); color: #0a0a0a; border-color: var(--axm-lime); font-weight: 600; }
      .axm-chip-on svg { color: #0a0a0a; }
      .axm-chip-auto { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid currentColor; box-sizing: border-box; }
      .axm-chip-on .axm-chip-auto { border-color: #0a0a0a; }

      .axm-ai { display: flex; flex-direction: column; gap: 6px; }
      .axm-ai-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .axm-ai-status { font-size: 10.5px; color: var(--axm-ink3); display: inline-flex; align-items: center; gap: 6px; margin-right: auto; }
      .axm-ai-status.axm-ai-on { color: var(--axm-ink2); }
      .axm-ai-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--axm-lime); box-shadow: 0 0 7px var(--axm-lime); }
      .axm-ai-form { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--axm-line); border-radius: 8px; background: var(--axm-soft); }
      .axm-ai-providers { display: flex; gap: 5px; flex-wrap: wrap; }
      .axm-ai-input { width: 100%; box-sizing: border-box; font-family: var(--font-mono, monospace); font-size: 12px; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--axm-line); background: var(--vocs-background-color-primary); color: var(--axm-ink); }
      .axm-ai-input::placeholder { color: var(--axm-ink3); }
      .axm-ai-input:focus { outline: none; border-color: var(--axm-lime-ink); }
      .axm-ai-row2 { display: flex; gap: 6px; }
      .axm-ai-model { flex: 1; }
      .axm-ai-connect { padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; border: 1px solid var(--axm-lime); background: var(--axm-lime); color: #0a0a0a; white-space: nowrap; }
      .axm-ai-connect:disabled { opacity: 0.4; cursor: not-allowed; }
      .axm-ai-note { font-size: 9.5px; line-height: 1.5; color: var(--axm-ink3); }
      .axm-ai-err { font-size: 10px; color: light-dark(#b91c1c, #f0857d); }

      .axm-action-row { display: flex; align-items: center; gap: 0.8rem; }
      .axm-mine-btn {
        flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.55rem;
        padding: 0.62rem 1rem; border-radius: 8px; cursor: pointer;
        font-size: 13.5px; font-weight: 600; letter-spacing: -0.01em;
        border: 1px solid var(--axm-lime); background: var(--axm-lime); color: #0a0a0a;
        transition: transform 0.15s ease, background 0.15s ease;
      }
      .axm-mine-btn:hover { transform: translateY(-1px); background: color-mix(in oklab, var(--axm-lime) 88%, #fff); }
      .axm-btn-ind { width: 7px; height: 7px; border-radius: 1px; background: #0a0a0a; }
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
        flex: 1; min-height: 84px; overflow-y: auto;
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
