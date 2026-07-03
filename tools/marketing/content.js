"use strict";

/**
 * AXIS AI — marketing content generator (no AI API).
 *
 * Captions are assembled from curated, on-brand templates plus a few live
 * protocol facts (best-effort). This keeps posting free and always on-message —
 * there is no LLM/API cost and no risk of a model going off-brand. Every caption
 * still passes the deterministic quality benchmark in quality.js before it can
 * be published.
 *
 * Each theme carries several hook/body variants; a rotating counter picks a
 * different combination each run so posts don't repeat verbatim.
 */

// Curated hashtag pools. Kept tight and relevant (Instagram penalises spammy,
// oversized, or banned tags). 8–12 are used per post.
const CORE_TAGS = ["axis", "axisai", "crypto", "base", "onchain"];
const THEME_TAGS = {
  fairlaunch: ["fairlaunch", "tokenomics", "bitcoin", "web3", "altcoin"],
  browser: ["mining", "cryptomining", "passiveincome", "web3", "defi"],
  usefulwork: ["ai", "proofofwork", "compute", "machinelearning", "tech"],
  computemarket: ["ai", "aiagents", "compute", "gpu", "defi"],
  noncustodial: ["selfcustody", "notyourkeys", "web3", "privacy", "wallet"],
  onbase: ["base", "basechain", "coinbase", "l2", "ethereum"],
  genesis: ["earlyadopter", "mining", "crypto", "altseason", "web3"],
};

// Themes. Each is TRUE about AXIS (fixed 84M supply, PoAIW, non-custodial,
// browser/terminal mining, compute market, deployed on Base, no admin keys).
const THEMES = [
  {
    id: "fairlaunch",
    hooks: [
      "84,000,000 AXIS. That's all there will ever be.",
      "No premine. No insiders. No hidden wallet.",
      "A crypto with a hard cap and an honest start.",
    ],
    bodies: [
      [
        "Every AXIS is mined by doing real AI work.",
        "Fixed supply, forever — nobody can print more.",
      ],
      [
        "No founder allocation. No treasury. No admin keys.",
        "The rules were set at launch and can't be changed.",
      ],
    ],
    ctas: ["Mine your first AXIS — link in bio.", "Start mining free — link in bio."],
  },
  {
    id: "browser",
    hooks: [
      "You can mine AXIS right in your browser.",
      "No rig. No GPU farm. Just a browser.",
    ],
    bodies: [
      [
        "Open the site, and a wallet is made on your device.",
        "Do a bit of AI work, and you earn AXIS. That simple.",
      ],
      [
        "No signup, no account, no one holding your funds.",
        "The keys are yours from the first second.",
      ],
    ],
    ctas: ["Try it now — link in bio.", "Mine in one click — link in bio."],
  },
  {
    id: "usefulwork",
    hooks: [
      "Old mining burns power on puzzles that mean nothing.",
      "What if mining actually made something useful?",
    ],
    bodies: [
      [
        "AXIS mines by doing real AI work — inference, training, validation.",
        "Every job that checks out is worth something on its own.",
      ],
      [
        "Same idea as Bitcoin's Proof-of-Work.",
        "But the work is real AI, not a wasted hash.",
      ],
    ],
    ctas: ["See how it works — link in bio.", "Read the whitepaper — link in bio."],
  },
  {
    id: "computemarket",
    hooks: [
      "Pay AXIS. Get real AI compute back.",
      "AXIS isn't just mined — it's used.",
    ],
    bodies: [
      [
        "Spend AXIS for real model inference, served by miners.",
        "Every paid job burns a share of AXIS, so supply only tightens.",
      ],
      [
        "A token you earn by doing AI work — and spend to get AI work done.",
        "Demand and scarcity, built into the protocol.",
      ],
    ],
    ctas: ["Explore the compute market — link in bio.", "Learn more — link in bio."],
  },
  {
    id: "noncustodial",
    hooks: [
      "Your keys. Your AXIS. Nobody in between.",
      "Not your keys, not your coins — so we gave you the keys.",
    ],
    bodies: [
      [
        "The mining wallet is made on your device and stays there.",
        "No custodian can freeze it, seize it, or lock you out.",
      ],
      [
        "Back up your 12 words and you're in full control.",
        "AXIS never holds your funds — it can't.",
      ],
    ],
    ctas: ["Start self-custody mining — link in bio.", "Get started — link in bio."],
  },
  {
    id: "onbase",
    hooks: [
      "AXIS is live on Base.",
      "Built on Base — fast, cheap, and real.",
    ],
    bodies: [
      [
        "Real on-chain rewards, settled on Base mainnet.",
        "Mine from your browser, terminal, or Telegram.",
      ],
      [
        "The contracts are live and ownerless on Base.",
        "Fixed supply, verifiable work, no admin keys.",
      ],
    ],
    ctas: ["Mine on Base — link in bio.", "Join now — link in bio."],
  },
  {
    id: "genesis",
    hooks: [
      "The first 21,000,000 AXIS are being mined now.",
      "Genesis mining is live. The earliest work earns the most.",
    ],
    bodies: [
      [
        "Rewards start high and step down over four epochs.",
        "Early miners earn the most — just like Bitcoin's first years.",
      ],
      [
        "25% of all AXIS is up for grabs in the Genesis phase.",
        "After that, it only gets harder to mine.",
      ],
    ],
    ctas: ["Mine while it's early — link in bio.", "Start now — link in bio."],
  },
];

const DISCLAIMER =
  "Not financial advice. AXIS is a mined commodity token — do your own research.";

/** Fetches a couple of live protocol facts (best-effort; never throws). */
async function fetchFacts(statsUrl) {
  const facts = {};
  if (!statsUrl) return facts;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(statsUrl, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const d = await res.json();
      if (typeof d.percent_mined === "number") {
        facts.percentMined = d.percent_mined;
      }
    }
  } catch (_) {
    /* offline / unreachable — omit live facts */
  }
  return facts;
}

/** Builds the hashtag block for a theme (core + theme tags, deduped). */
function buildHashtags(themeId) {
  const tags = [...CORE_TAGS, ...(THEME_TAGS[themeId] || [])];
  const seen = new Set();
  const out = [];
  for (const t of tags) {
    const clean = t.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(`#${clean}`);
    }
  }
  return out.slice(0, 12).join(" ");
}

/** Picks an item from `arr` by a rotating counter (deterministic, varied). */
function pick(arr, n) {
  return arr[n % arr.length];
}

/**
 * Generates a marketing post.
 *
 * @param {object} opts
 * @param {number} [opts.counter=0] Rotation counter (from persisted state).
 * @param {string} [opts.themeId]   Force a specific theme; otherwise rotates.
 * @param {string} [opts.statsUrl]  Public stats endpoint for live facts.
 * @returns {Promise<{ themeId, caption, hashtags }>}
 */
async function generatePost({ counter = 0, themeId, statsUrl } = {}) {
  const theme = themeId
    ? THEMES.find((t) => t.id === themeId) || THEMES[counter % THEMES.length]
    : THEMES[counter % THEMES.length];

  const facts = await fetchFacts(statsUrl);
  const variant = Math.floor(counter / THEMES.length);

  const hook = pick(theme.hooks, variant);
  const body = pick(theme.bodies, variant);
  const cta = pick(theme.ctas, variant);

  const lines = [hook, "", ...body];
  if (typeof facts.percentMined === "number") {
    lines.push("", `Genesis mining is ${facts.percentMined.toFixed(2)}% complete.`);
  }
  lines.push("", cta, "", DISCLAIMER, "", buildHashtags(theme.id));

  return {
    themeId: theme.id,
    caption: lines.join("\n"),
    hashtags: buildHashtags(theme.id),
  };
}

module.exports = { generatePost, THEMES, DISCLAIMER, buildHashtags, fetchFacts };
