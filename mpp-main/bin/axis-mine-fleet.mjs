#!/usr/bin/env node
// ===========================================================================
// AXIS AI — multi-wallet fleet miner.
//
// Mine AXIS from several self-custodial wallets at once, each with its OWN
// 12-word seed saved to its own file (~/.axis/wallet-N.json, chmod 600) and
// reused across runs. Every wallet is independent — losing/leaking one never
// exposes the others — and each prints its seed once so you can back it up.
//
//   pnpm mine:fleet                                  # 3 wallets vs $GATEWAY_URL
//   node bin/axis-mine-fleet.mjs --wallets 4         # 4 wallets
//   GATEWAY_URL=https://axis-gateway-production.up.railway.app node bin/axis-mine-fleet.mjs --wallets 4
//   node bin/axis-mine-fleet.mjs --wallets 3 --work inference_text
//
// AI keys (OPENAI_API_KEY / ANTHROPIC_API_KEY) and any flag are inherited by
// every wallet's miner. Ctrl+C stops the whole fleet.
// ===========================================================================
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MINER = join(here, "axis-miner.mjs");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const N = Math.max(1, Number.parseInt(arg("wallets", "3"), 10) || 3);
// --start offsets the wallet numbering (default 1). --dir puts this batch in its
// OWN folder so it never opens wallets from another batch: a relative name lives
// under ~/.axis (e.g. --dir batch2 → ~/.axis/batch2), an absolute path is used
// as-is. Together they guarantee a new batch can't touch or overwrite existing
// seeds — nothing you already mined is affected.
const START = Math.max(1, Number.parseInt(arg("start", "1"), 10) || 1);
// Seconds to wait between starting each wallet, so they don't all hit the
// gateway at once and trip its per-IP rate limit / DDoS ban. Default 4s.
const STAGGER = Math.max(0, Number.parseFloat(arg("stagger", "4")) || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Status-poll interval passed to every miner, scaled up with wallet count so the
// combined polling from all wallets stays under the gateway's per-IP rate limit
// (100 req/min). ~500ms per wallet, floor 3s. 10 wallets → 5s, 20 → 10s. Override
// with --poll-ms.
const POLL_MS = Math.max(3000, Number.parseInt(arg("poll-ms", String(N * 500)), 10) || N * 500);
const GATEWAY = arg("gateway", process.env.GATEWAY_URL || "https://axis-gateway-production.up.railway.app");
const WORK = arg("work", "auto");
const dirArg = arg("dir", "");
const DIR = dirArg
  ? (isAbsolute(dirArg) ? dirArg : join(homedir(), ".axis", dirArg))
  : join(homedir(), ".axis");
const END = START + N - 1;
mkdirSync(DIR, { recursive: true });

const COLORS = ["\x1b[36m", "\x1b[32m", "\x1b[35m", "\x1b[33m", "\x1b[34m", "\x1b[31m"];
const tty = process.stdout.isTTY;
const tag = (i) => (tty ? `${COLORS[(i - 1) % COLORS.length]}[w${i}]\x1b[0m` : `[w${i}]`);

console.log(`\n  ◆ AXIS fleet miner — ${N} independent wallets`);
console.log(`  gateway  ${GATEWAY}`);
console.log(`  wallets  ${DIR}/wallet-${START}..${END}.json (each a separate seed, chmod 600)`);
console.log(`  stagger  ${STAGGER}s between wallet starts (avoids the gateway's per-IP burst ban)`);
console.log(`  poll     every ${(POLL_MS / 1000).toFixed(1)}s per wallet (keeps total requests under the 100/min IP cap)`);
console.log(`  Each wallet prints its 12-word seed once — back them up. Ctrl+C stops all.\n`);

const children = [];
for (let i = START; i <= END; i++) {
  if (i > START && STAGGER) await sleep(STAGGER * 1000); // spread the load; no startup burst
  const file = join(DIR, `wallet-${i}.json`);
  const child = spawn(
    process.execPath,
    [MINER, "--wallet-file", file, "--gateway", GATEWAY, "--work", WORK, "--poll-ms", String(POLL_MS)],
    { env: process.env },
  );
  const pipe = (stream) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) console.log(`${tag(i)} ${line}`);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => console.log(`${tag(i)} miner exited (${code})`));
  children.push(child);
}

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) return;
  stopping = true;
  console.log("\n  stopping the fleet…");
  for (const c of children) c.kill("SIGINT");
  setTimeout(() => process.exit(0), 800);
});
