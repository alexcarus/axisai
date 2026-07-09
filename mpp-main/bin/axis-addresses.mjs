#!/usr/bin/env node
// ===========================================================================
// AXIS AI — list wallet PUBLIC ADDRESSES for a fleet batch.
//
// Reads each wallet-*.json seed file and prints only its public 0x address —
// the 12-word mnemonic is NEVER printed, so it's safe to run/share the output.
// Uses the same deriver as the miner (viem mnemonicToAccount), so addresses
// match exactly.
//
//   node bin/axis-addresses.mjs            # ~/.axis (wallet.json + wallet-N.json)
//   node bin/axis-addresses.mjs batch2     # ~/.axis/batch2
//   node bin/axis-addresses.mjs C:\path\to\dir
// ===========================================================================
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { mnemonicToAccount } from "viem/accounts";

const a = process.argv[2] || "";
const DIR = a ? (isAbsolute(a) ? a : join(homedir(), ".axis", a)) : join(homedir(), ".axis");
const num = (f) => Number.parseInt((f.match(/\d+/) || ["0"])[0], 10);
const norm = (m) => String(m).trim().replace(/\s+/g, " ");

let files;
try {
  files = readdirSync(DIR).filter((f) => /^wallet(-\d+)?\.json$/.test(f)).sort((x, y) => num(x) - num(y));
} catch {
  console.error(`  no such folder: ${DIR}`);
  process.exit(1);
}

console.log(`\n  AXIS wallet addresses in ${DIR}\n`);
for (const f of files) {
  try {
    const mn = JSON.parse(readFileSync(join(DIR, f), "utf8")).mnemonic;
    console.log(`  ${f.padEnd(18)} ${mnemonicToAccount(norm(mn)).address}`);
  } catch (e) {
    console.log(`  ${f.padEnd(18)} (could not read: ${e.message})`);
  }
}
console.log(`\n  ${files.length} wallet(s). Addresses are public — safe to keep/share. Seeds stay in the files.\n`);
