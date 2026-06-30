// ---------------------------------------------------------------------------
// AXIS site bot — answers questions from this site's own documented content.
//
// This is NOT an AI model and makes no network call: it scores the question
// against a small keyword-indexed knowledge base distilled from the Overview,
// Compute, Market, FAQ and Whitepaper pages, and returns the best match. Keeps
// "Ask AXIS" instant, offline, and grounded only in what the site actually says.
// ---------------------------------------------------------------------------

type Entry = {
  /** Lowercase keywords/phrases that route a question to this answer. */
  keywords: string[];
  answer: string;
};

const KB: Entry[] = [
  {
    keywords: [
      "what is axis",
      "proof of ai work",
      "proof-of-ai-work",
      "poaiw",
      "how does mining work",
      "how mining works",
      "what is mining",
      "about axis",
      "explain axis",
    ],
    answer:
      "AXIS AI is a decentralized Proof-of-AI-Work (PoAIW) protocol. Instead of hashing, miners perform verifiable AI work — text, image and audio inference, training steps, dataset labeling, synthetic data, and peer validation — and earn AXIS once the work is scored by deterministic functions and cross-checked by peers. Supply is permanently fixed at 84,000,000 AXIS: no premine, no founder allocation, no treasury, no admin keys.",
  },
  {
    keywords: [
      "how do i mine",
      "how to mine",
      "start mining",
      "begin mining",
      "get started",
      "how do i start",
      "mine axis",
    ],
    answer:
      "Two ways to mine:\n\n1) In your browser — open the miner on the home page. It derives a non-custodial wallet and mines for verified work (live when a gateway is configured, otherwise a faithful simulation).\n2) From your terminal — clone the repo, run `pnpm install`, then `pnpm mine`. It creates a 12-word wallet, signs Proof-of-AI-Work, and earns AXIS against the live AXIS gateway.\n\nConnect an OpenAI or Anthropic key to mine with real AI inference. A wallet and a verifiable AI workload are all you need — no KYC, no whitelist, no minimum stake.",
  },
  {
    keywords: [
      "wallet",
      "create wallet",
      "make a wallet",
      "seed",
      "seed phrase",
      "private key",
      "12 words",
      "mnemonic",
      "how do i create",
      "back up",
    ],
    answer:
      "Your wallet is a 12-word seed phrase you control — AXIS is non-custodial, so rewards accrue to keys only you hold.\n\n• Browser miner: a wallet is generated for you. Set a password to encrypt and save it locally, and back up the 12 words.\n• Terminal miner: `pnpm mine` generates a seed on the first run and saves it to ~/.axis/wallet.json. It prints the 12 words once — write them down.\n\nThe same 12 words restore the exact wallet in the browser, terminal and Telegram, so one wallet works everywhere. Anyone with your seed can take your AXIS, and it can never be recovered for you.",
  },
  {
    keywords: [
      "25%",
      "25 percent",
      "genesis",
      "what happens at",
      "threshold",
      "activates",
      "halving",
      "epoch",
    ],
    answer:
      "The Genesis Phase distributes the first 21,000,000 AXIS — exactly 25% of the 84,000,000 supply — through open mining, with rewards declining across four epochs (200 → 100 → 50 → 25 AXIS per block) to reward the earliest miners.\n\nOnce 25% is mined, two things happen on the same on-chain threshold: an automatic supply-driven difficulty ramp kicks in (1.0× rising to 8.0× at the cap), and the AXIS Compute marketplace switches on.",
  },
  {
    keywords: [
      "compute",
      "compute market",
      "marketplace",
      "pay for ai",
      "pay axis",
      "buy compute",
      "tier",
      "serve",
      "inference job",
    ],
    answer:
      "AXIS Compute is a two-sided AI marketplace. You pay AXIS for real model inference; a distributed miner picks up the job, runs it on their own hardware and AI key, and is paid your AXIS straight to their wallet.\n\nPick a tier — Fast, Balanced, or Pro. A stronger model costs more AXIS; a lighter one is cheap. You pay AXIS on Base, a miner serves the job, and you get the output back. You can also attach a file for the model to read. Prices are quoted from the live Uniswap AXIS price. It activates after Genesis (25% of supply mined).",
  },
  {
    keywords: [
      "market",
      "trade",
      "trading",
      "swap",
      "buy axis",
      "sell axis",
      "uniswap",
      "price",
      "usdc",
      "liquidity",
    ],
    answer:
      "The AXIS Market is a real on-chain swap against the Uniswap v4 AXIS/USDC pool on Base. Connect your wallet, get a live quote read straight from the pool (including price impact and the 1% pool fee), and swap real USDC ↔ AXIS. Nothing is simulated — every trade settles on Base and moves the real pool price. The 1% fee accrues to liquidity providers. AXIS Compute quotes its prices from this same Uniswap price.",
  },
  {
    keywords: [
      "supply",
      "total supply",
      "how many axis",
      "84 million",
      "84,000,000",
      "84000000",
      "tokenomics",
      "inflation",
      "fixed supply",
      "max supply",
    ],
    answer:
      "Total supply is permanently fixed at 84,000,000 AXIS — no inflation, no emergency minting, no governance override. 100% is mined: no premine, no founder allocation, no treasury, no admin keys.\n\nThe first 25% (21,000,000 AXIS) is the Genesis Phase; after that the network moves through the Standard, Late and Terminal phases under the same deterministic emission.",
  },
  {
    keywords: [
      "reward",
      "formula",
      "how much",
      "how do i earn",
      "earn",
      "quality score",
      "difficulty",
      "calculation",
    ],
    answer:
      "Rewards follow a deterministic formula:\n\n  AXIS Reward = baseEpochReward × (W × Q) / (D × 100)\n\nW = verified AI workload units, Q = the quality score (0.0–1.0) of your output, D = the per-epoch difficulty factor. All three are protocol-determined — no miner can inflate W beyond verified work, manipulate Q outside the scoring function, or alter D.",
  },
  {
    keywords: [
      "work type",
      "work types",
      "kinds of work",
      "tasks",
      "what work",
      "eligible work",
    ],
    answer:
      "There are seven eligible work types: text inference (coherent, relevant text), image inference (scored against a reference via SSIM), audio inference (MFCC feature frames), training step (a plausible loss decrease), dataset labeling (agreement with peers), synthetic data generation (matching a reference distribution), and peer validation (scoring other miners against consensus).",
  },
  {
    keywords: ["telegram", "whatsapp", "bot", "chat", "mobile", "export"],
    answer:
      "AXIS is also reachable from chat. The Telegram and WhatsApp agents let you submit tasks, monitor mining, and receive rewards. Each channel user gets a deterministic, re-derivable mining wallet — the bot is a gateway, never a custodian. Export your key from the Telegram bot (/export) and import the same wallet into the web or terminal miner to share one balance.",
  },
  {
    keywords: [
      "custody",
      "custodial",
      "non-custodial",
      "safe",
      "secure",
      "security",
      "freeze",
      "seize",
      "is it safe",
    ],
    answer:
      "AXIS is non-custodial — rewards accrue to keys you control, and no custodian can freeze or seize your mined AXIS. The web miner encrypts your wallet seed with your password locally (AES-GCM/PBKDF2) and never sends it to AXIS. Market swaps are signed in your own wallet and can't move funds without your explicit approval, and the market auto-disconnects after 15 minutes of inactivity for safety on shared machines.",
  },
  {
    keywords: ["fee", "fees", "cost", "how much does it cost", "is it free"],
    answer:
      "Mining itself is free — a wallet and a verifiable AI workload are all you need. The AXIS Market charges a 1% pool fee that goes to liquidity providers (there's no separate protocol fee). In AXIS Compute you pay the tier price in AXIS; the treasury forwards it to the miner who served your job, retaining a small protocol/gas fee.",
  },
  {
    keywords: [
      "launch",
      "run the stack",
      "self host",
      "self-host",
      "start.sh",
      "deploy",
      "gateway url",
      "host it myself",
    ],
    answer:
      "The whole protocol is open-source. Bring up the stack with `./start.sh` — it starts Postgres, Redis and a chain node, deploys the ValidatorRegistry, the fixed-supply AXISToken and the MarketplaceEscrow, migrates, then starts the engine, gateway and marketplace. The browser, terminal and bots all submit to the API gateway; point clients at it with VITE_AXIS_GATEWAY_URL (website) or GATEWAY_URL (terminal).",
  },
];

const FALLBACK =
  "I answer from what this site documents — Proof-of-AI-Work mining, creating a wallet, the fixed 84,000,000 supply, the Genesis 25% threshold, the AXIS Compute marketplace, and the Uniswap AXIS/USDC market. Try asking about one of those, or see the Overview, Whitepaper, or FAQ pages.";

/**
 * Answers a question from the site's content. Scores each knowledge-base entry
 * by how many of its keywords appear in the question (longer phrases weigh more,
 * so specific matches beat generic words), and returns the best one — or a
 * pointer to the right pages when nothing matches.
 */
export function answerFromSite(question: string): string {
  const q = ` ${question.toLowerCase().replace(/[^a-z0-9%$.,/ ]+/g, " ")} `;
  let best: Entry | null = null;
  let bestScore = 0;
  for (const entry of KB) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (q.includes(kw)) score += kw.split(" ").length;
    }
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return best ? best.answer : FALLBACK;
}
