// ---------------------------------------------------------------------------
// AXIS AI — browser wallet vault (password-encrypted).
//
// The mining seed is encrypted with a user password (AES-256-GCM, key derived
// via PBKDF2-SHA256 / 310k iterations) before it ever touches localStorage, so
// what's stored at rest is ciphertext — unreadable by browser extensions, other
// scripts on the page (analytics, etc.), or anyone reading the profile. The
// plaintext seed exists only in memory during a session, held in React refs
// (never global, never the DOM), and is never sent to AXIS or any server.
//
// This is still a hot wallet (the key is in memory while mining) — fine for
// mining and modest balances; sweep larger holdings to a hardware/cold wallet.
// ---------------------------------------------------------------------------

import {
  generateSeedWallet,
  type MiningWallet,
  walletFromMnemonic,
  walletFromSecret,
} from "./axis";

const VAULT_KEY = "axis.miner.vault.v2";
const LEGACY_KEY = "axis.miner.seed.v1"; // pre-encryption plaintext (migrated away)
const LEGACY_BACKUP = "axis.miner.backedup.v1";

type Vault = { v: 2; addr: string; salt: string; iv: string; ct: string };

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(
  password: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password) as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 310_000,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** True if an encrypted wallet vault exists in this browser. */
export function hasVault(): boolean {
  return !!storage()?.getItem(VAULT_KEY);
}

/** The wallet's public address without unlocking (safe — address only). */
export function vaultAddress(): string | null {
  const raw = storage()?.getItem(VAULT_KEY);
  if (!raw) return null;
  try {
    return (JSON.parse(raw) as Vault).addr;
  } catch {
    return null;
  }
}

/** Encrypts a wallet's seed (or key) under `password` and stores the vault. */
export async function saveEncrypted(
  wallet: MiningWallet,
  password: string,
): Promise<void> {
  const ls = storage();
  if (!ls) return;
  const secret = wallet.mnemonic ?? wallet.privateKey; // seed preferred
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(secret) as BufferSource,
    ),
  );
  const vault: Vault = {
    v: 2,
    addr: wallet.address,
    salt: b64(salt),
    iv: b64(iv),
    ct: b64(ct),
  };
  ls.setItem(VAULT_KEY, JSON.stringify(vault));
  // Remove any pre-encryption plaintext.
  ls.removeItem(LEGACY_KEY);
  ls.removeItem(LEGACY_BACKUP);
}

/** Decrypts the vault. Returns the wallet, or null on wrong password / none. */
export async function unlock(password: string): Promise<MiningWallet | null> {
  const raw = storage()?.getItem(VAULT_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Vault;
    const key = await deriveKey(password, unb64(v.salt));
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(v.iv) as BufferSource },
      key,
      unb64(v.ct) as BufferSource,
    );
    return walletFromSecret(new TextDecoder().decode(new Uint8Array(pt)));
  } catch {
    return null; // wrong password or corrupt vault
  }
}

/** Loads a legacy plaintext wallet (pre-encryption) for one-time migration. */
export function loadLegacy(): MiningWallet | null {
  const legacy = storage()?.getItem(LEGACY_KEY);
  if (!legacy) return null;
  try {
    const p = JSON.parse(legacy) as { mnemonic?: string; privateKey?: string };
    if (p.mnemonic) return walletFromMnemonic(p.mnemonic);
    if (p.privateKey) return walletFromSecret(p.privateKey);
  } catch {
    /* corrupt */
  }
  return null;
}

/** A brand-new in-memory seed wallet (not persisted until encrypted+saved). */
export function freshWallet(): MiningWallet {
  return generateSeedWallet();
}

/** Removes the vault (and any legacy plaintext) from this browser. */
export function clearVault(): void {
  const ls = storage();
  if (!ls) return;
  ls.removeItem(VAULT_KEY);
  ls.removeItem(LEGACY_KEY);
  ls.removeItem(LEGACY_BACKUP);
}
