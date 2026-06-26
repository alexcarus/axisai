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
//   GATEWAY_URL=https://gateway.axis.ai node bin/axis-mine-fleet.mjs --wallets 4
//   node bin/axis-mine-fleet.mjs --wallets 3 --work inference_text
//
// AI keys (OPENAI_API_KEY / ANTHROPIC_API_KEY) and any flag are inherited by
// every wallet's miner. Ctrl+C stops the whole fleet.
// ===========================================================================
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MINER = join(here, "axis-miner.mjs");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const N = Math.max(1, Number.parseInt(arg("wallets", "3"), 10) || 3);
const GATEWAY = arg("gateway", process.env.GATEWAY_URL || "http://localhost:3000");
const WORK = arg("work", "auto");
const DIR = join(homedir(), ".axis");
mkdirSync(DIR, { recursive: true });

const COLORS = ["\x1b[36m", "\x1b[32m", "\x1b[35m", "\x1b[33m", "\x1b[34m", "\x1b[31m"];
const tty = process.stdout.isTTY;
const tag = (i) => (tty ? `${COLORS[(i - 1) % COLORS.length]}[w${i}]\x1b[0m` : `[w${i}]`);

console.log(`\n  ◆ AXIS fleet miner — ${N} independent wallets`);
console.log(`  gateway  ${GATEWAY}`);
console.log(`  wallets  ${DIR}/wallet-1..${N}.json (each a separate seed, chmod 600)`);
console.log(`  Each wallet prints its 12-word seed once — back them up. Ctrl+C stops all.\n`);

const children = [];
for (let i = 1; i <= N; i++) {
  const file = join(DIR, `wallet-${i}.json`);
  const child = spawn(
    process.execPath,
    [MINER, "--wallet-file", file, "--gateway", GATEWAY, "--work", WORK],
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
