// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { generateSeedWallet, walletFromPrivateKey } from "./axis";
import {
  clearVault,
  hasVault,
  saveEncrypted,
  unlock,
  vaultAddress,
} from "./wallet-store";

// wallet-store persists via `window.localStorage`. Provide a minimal in-memory
// implementation so the encrypt → persist → decrypt round-trip runs in Node.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  get length(): number {
    return this.m.size;
  }
}

beforeEach(() => {
  (globalThis as unknown as { window: { localStorage: Storage } }).window = {
    localStorage: new MemStorage() as unknown as Storage,
  };
  clearVault();
});

describe("wallet backup (the predicate + persistence the wallet-home banner drives)", () => {
  it("flips 'backed up' from false→true and recovers the exact wallet", async () => {
    const w = generateSeedWallet();

    // Unsaved: banner would show (its predicate is exactly this).
    expect(hasVault()).toBe(false);
    expect(
      hasVault() &&
        vaultAddress()?.toLowerCase() === w.address.toLowerCase(),
    ).toBe(false);

    await saveEncrypted(w, "a-good-password");

    // Saved: predicate now true → banner hides.
    expect(hasVault()).toBe(true);
    expect(vaultAddress()?.toLowerCase()).toBe(w.address.toLowerCase());

    // Survives a "refresh": the right password recovers the same address.
    const recovered = await unlock("a-good-password");
    expect(recovered?.address).toBe(w.address);
  }, 20000);

  it("rejects the wrong password and works for key-only (no-mnemonic) wallets", async () => {
    const keyOnly = walletFromPrivateKey(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );
    expect(keyOnly.mnemonic).toBeUndefined();

    await saveEncrypted(keyOnly, "another-password");
    expect(vaultAddress()?.toLowerCase()).toBe(keyOnly.address.toLowerCase());
    expect(await unlock("nope")).toBeNull();
    expect((await unlock("another-password"))?.address).toBe(keyOnly.address);
  }, 20000);
});
