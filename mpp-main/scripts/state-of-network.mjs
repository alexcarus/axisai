// AXIS — daily "State of the Network" content generator.
// Reads the verified AXIS contract on Base (+ the Robinhood OFT) live and emits:
//   1) ready-to-post, SEC-safe post text (no price talk — supply/mining/fairness),
//   2) a branded SVG card (state-of-network.svg) you can post or convert.
// Read-only. Nothing on-chain is touched. Run: `node scripts/state-of-network.mjs`
// Schedule it (cron / GitHub Action) to have your #1 content stream run itself.

import { writeFileSync } from "node:fs";
import { createPublicClient, formatUnits, http } from "viem";
import { base } from "viem/chains";

const BASE_RPC = process.env.VITE_BASE_RPC_URL || "https://base-rpc.publicnode.com";
const HOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";
const AXIS = "0x6DBBd1910BeFC6736b818d4DcaD3ff833b9e06D7";
const OFT_HOOD = "0xcDbEb868D5955C04aD3A471388b5ebAeE65AcaE4";

const view = (name, outs = [{ type: "uint256" }]) => ({
  name, type: "function", stateMutability: "view", inputs: [], outputs: outs,
});
const AXIS_ABI = ["totalMinted", "totalBurned", "totalSupply", "MAX_SUPPLY", "GENESIS_SUPPLY", "currentEpoch", "currentBaseReward"].map((n) => view(n));
const TS_ABI = [view("totalSupply")];

const base_ = createPublicClient({ chain: base, transport: http(BASE_RPC) });
const hood = createPublicClient({ transport: http(HOOD_RPC) });
const rd = (client, address, abi, functionName) => client.readContract({ address, abi, functionName });
const n18 = (x) => Number(formatUnits(x, 18));
const fmt = (x, d = 0) => x.toLocaleString("en-US", { maximumFractionDigits: d });

const [minted, burned, circ, max, genesis, epoch, baseReward] = await Promise.all(
  ["totalMinted", "totalBurned", "totalSupply", "MAX_SUPPLY", "GENESIS_SUPPLY", "currentEpoch", "currentBaseReward"].map((f) => rd(base_, AXIS, AXIS_ABI, f)),
);
let bridged = 0n;
try { bridged = await rd(hood, OFT_HOOD, TS_ABI, "totalSupply"); } catch {}

const s = {
  minted: n18(minted), burned: n18(burned), circ: n18(circ), max: n18(max),
  genesis: n18(genesis), epoch: Number(epoch), baseReward: n18(baseReward), bridged: n18(bridged),
};
const minedPct = (s.minted / s.max) * 100;
const genesisPct = Math.min(100, (s.minted / s.genesis) * 100);

// --- SEC-safe post text (rotates by day; supply/mining/fairness only, no price) ---
const templates = [
  `AXIS · State of the Network\n\n⛏ ${fmt(s.minted)} / 84,000,000 AXIS mined (${minedPct.toFixed(2)}%) — every one earned by verified AI work (Proof-of-AI-Work).\n🔥 ${fmt(s.burned, 0)} AXIS burned forever.\nEpoch ${s.epoch} · fixed supply · no premine · no admin keys.\n\nVerify every number on-chain 👉 axismyai.com/network\n\nInformational only. Not investment advice.`,
  `Transparency, on-chain.\n\nAXIS is a fixed-supply commodity you MINE by doing real AI work — not a premine, not a team allocation.\n\n📊 Mined: ${fmt(s.minted)} of 84,000,000 (${minedPct.toFixed(2)}%)\n🔥 Burned: ${fmt(s.burned, 0)}\n🌉 Bridged to Robinhood: ${fmt(s.bridged, 0)}\n\nOwnerless, renounced, verifiable: axismyai.com/network\n\nNot investment advice.`,
  `Genesis progress: ${genesisPct.toFixed(2)}% of the first 25% mined.\n\nAXIS mints only for verified AI work — ${fmt(s.baseReward)} AXIS/unit this epoch. 3% of every mint is burned forever. No admin keys can change any of it.\n\nSee it live, verify the contracts: axismyai.com/network\n\nInformational only.`,
];
const post = templates[new Date().getUTCDate() % templates.length];

// --- Branded SVG card (self-contained; screenshot or convert to PNG for X) ---
const bar = Math.round(minedPct * 10) / 10;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080">
<rect width="1080" height="1080" fill="#0a0b0d"/>
<rect x="44" y="44" width="992" height="992" rx="24" fill="none" stroke="rgba(255,255,255,0.08)"/>
<g stroke="#eef1f6" stroke-linecap="round"><path d="M150 200v88" stroke-width="16"/><path d="M106 244h88" stroke-width="16"/><path d="M122 216l56 56" stroke-width="13"/><path d="M178 216l-56 56" stroke-width="13"/></g>
<text x="228" y="238" fill="#eef1f6" font-family="system-ui,sans-serif" font-weight="700" font-size="42">AXIS AI</text>
<text x="230" y="278" fill="#fbbf24" font-family="ui-monospace,monospace" font-size="24">STATE OF THE NETWORK</text>
<text x="92" y="470" fill="#f6f8fc" font-family="system-ui,sans-serif" font-weight="800" font-size="150">${minedPct.toFixed(2)}%</text>
<text x="96" y="540" fill="#fbbf24" font-family="system-ui,sans-serif" font-weight="700" font-size="46">of 84,000,000 AXIS mined</text>
<text x="96" y="600" fill="#9aa1ad" font-family="system-ui,sans-serif" font-size="34">${fmt(s.minted)} mined · ${fmt(s.burned, 0)} burned · Epoch ${s.epoch}</text>
<rect x="92" y="650" width="896" height="26" rx="13" fill="rgba(255,255,255,0.06)"/>
<rect x="92" y="650" width="${(896 * bar) / 100}" height="26" rx="13" fill="#fbbf24"/>
<line x1="92" y1="900" x2="988" y2="900" stroke="rgba(255,255,255,0.08)"/>
<text x="92" y="962" fill="#9aa1ad" font-family="system-ui,sans-serif" font-size="30">Fixed supply · no premine · no admin keys · verify on-chain</text>
<text x="92" y="1012" fill="#eef1f6" font-family="system-ui,sans-serif" font-weight="700" font-size="42">axismyai.com/network</text>
</svg>`;
writeFileSync(new URL("./state-of-network.svg", import.meta.url), svg);

console.log("=".repeat(64) + "\nPOST TEXT (copy to X / Farcaster):\n" + "=".repeat(64) + "\n");
console.log(post);

// Optional truly-hands-off delivery: POST to a webhook (Discord/Slack accept a
// simple JSON body; Discord reads `content`, Slack reads `text`). Set the
// POST_WEBHOOK_URL env/secret to auto-post the daily update to your channel.
const hook = process.env.POST_WEBHOOK_URL;
if (hook) {
  if (!(s.minted > 0) || !Number.isFinite(minedPct)) {
    console.warn(`Skipping webhook — on-chain read looks invalid (minted=${s.minted}).`);
  } else {
    try {
      const res = await fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: post, text: post }),
      });
      console.log(`Webhook: ${res.status} ${res.ok ? "posted ✓" : await res.text()}`);
    } catch (e) {
      console.log("Webhook post failed:", e.message);
    }
  }
}
console.log("\n" + "=".repeat(64) + "\nCard written: scripts/state-of-network.svg  (attach a screenshot of /network, or convert this SVG to PNG for X)\n");
