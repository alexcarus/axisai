"use client";

// ---------------------------------------------------------------------------
// AXIS AI — shared in-memory wallet session.
//
// One unlocked self-custodial wallet, shared across every feature (wallet home,
// bridge, send, mining) so the user unlocks ONCE per session. The wallet lives
// only in memory here (never persisted — the encrypted vault in wallet-store.ts
// is the at-rest form). Auto-locks after 15 minutes idle.
//
// This is what makes AXIS usable inside the Telegram Mini App: it needs no
// injected/extension wallet (there is none in Telegram) — the in-app key signs
// locally via its viem account.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react";
import type { MiningWallet } from "./axis";

const IDLE_MS = 15 * 60 * 1000;

let current: MiningWallet | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function clearIdle() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function armIdle() {
  if (typeof window === "undefined") return;
  clearIdle();
  idleTimer = setTimeout(() => lockWallet(), IDLE_MS);
}

/** Sets (or clears) the active unlocked wallet and notifies subscribers. */
export function setSessionWallet(wallet: MiningWallet | null): void {
  current = wallet;
  if (wallet) armIdle();
  else clearIdle();
  emit();
}

/** Locks the session — drops the in-memory key. */
export function lockWallet(): void {
  setSessionWallet(null);
}

/** The current unlocked wallet, or null. Safe to call outside React. */
export function getSessionWallet(): MiningWallet | null {
  return current;
}

/** Resets the idle auto-lock timer — call on user activity. */
export function touchSession(): void {
  if (current) armIdle();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React binding — re-renders when the session wallet changes. */
export function useSessionWallet(): MiningWallet | null {
  return useSyncExternalStore(
    subscribe,
    getSessionWallet,
    () => null, // server snapshot
  );
}
