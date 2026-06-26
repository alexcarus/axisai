// ---------------------------------------------------------------------------
// AXIS AI — browser-local mining wallet store.
//
// The web miner is a self-custodial hot wallet: the user's BIP-39 seed phrase
// is persisted ONLY in this browser's localStorage and never transmitted to
// AXIS or any server (every signature is produced locally). Persisting the seed
// means rewards survive a refresh — the same wallet (and balance) is restored
// on the next visit, and the same 12 words can be imported into the terminal
// miner or restored on another device.
//
// This is a hot wallet by design (the seed sits in localStorage so the miner
// can sign autonomously); the UI tells the user to back up the words and offers
// to clear them. For larger balances, mine to a hardware-secured address by
// importing only its key on a trusted machine.
// ---------------------------------------------------------------------------

import {
  generateSeedWallet,
  type MiningWallet,
  walletFromMnemonic,
  walletFromSecret,
} from "./axis";

const KEY = "axis.miner.seed.v1";
const BACKUP_KEY = "axis.miner.backedup.v1";

type Persisted = { mnemonic?: string; privateKey?: string };

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // Storage can throw in private-mode / sandboxed iframes.
    return null;
  }
}

/** Loads the wallet persisted in this browser, or null if none/corrupt. */
export function loadWallet(): MiningWallet | null {
  const ls = storage();
  if (!ls) return null;
  const raw = ls.getItem(KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Persisted;
    if (p.mnemonic) return walletFromMnemonic(p.mnemonic);
    if (p.privateKey) return walletFromSecret(p.privateKey);
  } catch {
    /* corrupt entry — fall through and treat as no wallet */
  }
  return null;
}

/** Persists a wallet — the seed phrase when available, else the private key. */
export function saveWallet(w: MiningWallet): void {
  const ls = storage();
  if (!ls) return;
  const p: Persisted = w.mnemonic
    ? { mnemonic: w.mnemonic }
    : { privateKey: w.privateKey };
  ls.setItem(KEY, JSON.stringify(p));
}

/** Returns the persisted wallet, or creates + persists a fresh seed wallet. */
export function loadOrCreateWallet(): MiningWallet {
  return loadWallet() ?? persistFresh();
}

/** Generates a brand-new seed wallet, persists it, and resets the backup flag. */
export function persistFresh(): MiningWallet {
  const w = generateSeedWallet();
  saveWallet(w);
  setBackedUp(false);
  return w;
}

/** Removes the persisted wallet (and backup flag) from this browser. */
export function clearWallet(): void {
  const ls = storage();
  if (!ls) return;
  ls.removeItem(KEY);
  ls.removeItem(BACKUP_KEY);
}

export function isBackedUp(): boolean {
  const ls = storage();
  return ls ? ls.getItem(BACKUP_KEY) === "1" : false;
}

export function setBackedUp(v: boolean): void {
  const ls = storage();
  if (!ls) return;
  if (v) ls.setItem(BACKUP_KEY, "1");
  else ls.removeItem(BACKUP_KEY);
}
