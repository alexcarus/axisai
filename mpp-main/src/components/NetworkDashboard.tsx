"use client";

// ---------------------------------------------------------------------------
// State of the Network — a live, on-chain transparency dashboard. Reads the
// verified AXIS contracts + the Uniswap v4 pool directly (no backend, no auth,
// NOTHING on-chain is changed). This is the trust/visibility centerpiece the
// whole marketing plan points at — every number links to on-chain proof.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { hoodClient, OFT_ROBINHOOD } from "../lib/bridge";
import { AXIS, getSpotPrice, publicClient } from "../lib/uniswap-v4";

const AXIS_ABI = [
  {
    name: "totalSupply",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "totalMinted",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "totalBurned",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "MAX_SUPPLY",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "GENESIS_SUPPLY",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "currentEpoch",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    name: "currentBaseReward",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

const ERC20_TS = [
  {
    name: "totalSupply",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

type Stats = {
  price: number;
  minted: number;
  burned: number;
  circulating: number;
  max: number;
  genesis: number;
  epoch: number;
  baseReward: number;
  bridged: number;
};

const fmtN = (n: number, d = 0) =>
  n.toLocaleString("en-US", { maximumFractionDigits: d });
const fmtUsd = (n: number) =>
  n >= 1
    ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : `$${n.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;

async function load(): Promise<Stats> {
  const [minted, burned, circulating, max, genesis, epoch, baseReward] =
    await Promise.all([
      publicClient.readContract({
        address: AXIS,
        abi: AXIS_ABI,
        functionName: "totalMinted",
      }),
      publicClient.readContract({
        address: AXIS,
        abi: AXIS_ABI,
        functionName: "totalBurned",
      }),
      publicClient.readContract({
        address: AXIS,
        abi: AXIS_ABI,
        functionName: "totalSupply",
      }),
      publicClient.readContract({
        address: AXIS,
        abi: AXIS_ABI,
        functionName: "MAX_SUPPLY",
      }),
      publicClient.readContract({
        address: AXIS,
        abi: AXIS_ABI,
        functionName: "GENESIS_SUPPLY",
      }),
      publicClient.readContract({
        address: AXIS,
        abi: AXIS_ABI,
        functionName: "currentEpoch",
      }),
      publicClient.readContract({
        address: AXIS,
        abi: AXIS_ABI,
        functionName: "currentBaseReward",
      }),
    ]);
  let price = 0;
  try {
    price = await getSpotPrice();
  } catch {
    /* pool read hiccup */
  }
  let bridged = 0n;
  try {
    bridged = (await hoodClient.readContract({
      address: OFT_ROBINHOOD,
      abi: ERC20_TS,
      functionName: "totalSupply",
    })) as bigint;
  } catch {
    /* robinhood rpc hiccup */
  }
  const n = (x: bigint) => Number(formatUnits(x, 18));
  return {
    price,
    minted: n(minted as bigint),
    burned: n(burned as bigint),
    circulating: n(circulating as bigint),
    max: n(max as bigint),
    genesis: n(genesis as bigint),
    epoch: Number(epoch),
    baseReward: n(baseReward as bigint),
    bridged: n(bridged),
  };
}

export function NetworkDashboard() {
  const [s, setS] = useState<Stats | null>(null);
  const [updated, setUpdated] = useState<number>(0);

  useEffect(() => {
    let alive = true;
    const run = () =>
      load()
        .then((r) => {
          if (alive) {
            setS(r);
            setUpdated(Date.now());
          }
        })
        .catch(() => {});
    run();
    const t = setInterval(run, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const mcap = s ? s.price * s.circulating : 0;
  const fdv = s ? s.price * s.max : 0;
  const minedPct = s ? (s.minted / s.max) * 100 : 0;
  const genesisPct = s ? Math.min(100, (s.minted / s.genesis) * 100) : 0;
  const v = (x: string) => (s ? x : "…");

  const cards: Array<[string, string, string?]> = [
    ["AXIS price", v(fmtUsd(s?.price ?? 0)), "live Uniswap v4 · Base"],
    ["Market cap", v(fmtUsd(mcap)), "price × circulating"],
    ["Fully-diluted value", v(fmtUsd(fdv)), "price × 84,000,000"],
    [
      "Supply mined",
      v(`${fmtN(s?.minted ?? 0)} / 84,000,000`),
      `${minedPct.toFixed(2)}% of max`,
    ],
    [
      "Genesis progress",
      v(`${genesisPct.toFixed(2)}%`),
      "first 25% (21,000,000)",
    ],
    ["Circulating", v(fmtN(s?.circulating ?? 0)), "net of burns"],
    ["Burned forever", v(fmtN(s?.burned ?? 0, 2)), "3% of every mint"],
    [
      "Current epoch",
      v(`Epoch ${s?.epoch ?? "—"}`),
      `${fmtN(s?.baseReward ?? 0)} AXIS / unit`,
    ],
    ["Bridged to Robinhood", v(fmtN(s?.bridged ?? 0, 2)), "1:1 LayerZero OFT"],
  ];

  return (
    <div className="axn">
      <Styles />
      <div className="axn-head">
        <div>
          <div className="axn-eyebrow">Proof-of-AI-Work · Base + Robinhood</div>
          <h2 className="axn-title">State of the Network</h2>
        </div>
        <div className="axn-live">
          <span className="axn-dot" />
          {updated ? "live · on-chain" : "loading…"}
        </div>
      </div>

      <div className="axn-bar">
        <div className="axn-bar-fill" style={{ width: `${minedPct}%` }} />
        <span className="axn-bar-label">
          {fmtN(s?.minted ?? 0)} of 84,000,000 AXIS mined ({minedPct.toFixed(2)}
          %)
        </span>
      </div>

      <div className="axn-grid">
        {cards.map(([label, value, sub]) => (
          <div key={label} className="axn-card">
            <div className="axn-card-l">{label}</div>
            <div className="axn-card-v">{value}</div>
            {sub && <div className="axn-card-s">{sub}</div>}
          </div>
        ))}
      </div>

      <div className="axn-proof">
        <span>Verify it yourself:</span>
        <a
          href="https://basescan.org/token/0x6DBBd1910BeFC6736b818d4DcaD3ff833b9e06D7"
          target="_blank"
          rel="noreferrer"
        >
          AXIS on BaseScan ↗
        </a>
        <a
          href="https://robinhoodchain.blockscout.com/token/0xcDbEb868D5955C04aD3A471388b5ebAeE65AcaE4"
          target="_blank"
          rel="noreferrer"
        >
          AXIS on Robinhood ↗
        </a>
        <a href="/whitepaper">Whitepaper</a>
      </div>
      <div className="axn-foot">
        84,000,000 fixed supply · no premine · no admin keys ·
        ownerless/renounced · contracts verified on both chains. Every figure
        above is read live from the chain — nothing here is editable by anyone.
        Informational only, not investment advice.
      </div>
    </div>
  );
}

function Styles() {
  return (
    <style>{`
      .axn {
        --a: light-dark(#1f9d63, #7fe0a8);
        --line: light-dark(rgba(9,9,11,0.10), rgba(255,255,255,0.09));
        --soft: light-dark(rgba(9,9,11,0.028), rgba(255,255,255,0.03));
        --ink: var(--vocs-text-color-heading);
        --ink2: var(--vocs-text-color-secondary);
        --ink3: var(--vocs-text-color-muted);
        width: 100%; font-family: var(--font-sans);
      }
      .axn-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
      .axn-eyebrow { font-family: var(--font-mono); font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink3); }
      .axn-title { font-size: clamp(1.5rem, 3.5vw, 2.2rem); font-weight: 600; letter-spacing: -0.02em; margin: 0.4rem 0 0; color: var(--ink); }
      .axn-live { display: inline-flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: 0.72rem; color: var(--ink3); white-space: nowrap; }
      .axn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--a); box-shadow: 0 0 8px var(--a); }

      .axn-bar { position: relative; height: 34px; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; background: var(--soft); margin-bottom: 1rem; }
      .axn-bar-fill { height: 100%; background: linear-gradient(90deg, color-mix(in oklab, var(--a) 60%, transparent), var(--a)); transition: width 0.6s ease; }
      .axn-bar-label { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: var(--font-mono); font-size: 0.74rem; color: var(--ink); }

      .axn-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
      .axn-card { background: var(--vocs-background-color-primary); padding: clamp(0.9rem, 2vw, 1.3rem); }
      .axn-card-l { font-size: 0.72rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink3); }
      .axn-card-v { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: clamp(1.05rem, 2.2vw, 1.5rem); font-weight: 600; color: var(--ink); margin-top: 0.4rem; letter-spacing: -0.01em; }
      .axn-card-s { font-size: 0.72rem; color: var(--ink3); margin-top: 0.3rem; }
      @media (max-width: 820px) { .axn-grid { grid-template-columns: repeat(2, 1fr); } }
      @media (max-width: 520px) { .axn-grid { grid-template-columns: 1fr; } }

      .axn-proof { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 1rem; margin-top: 1.1rem; font-size: 0.82rem; color: var(--ink3); }
      .axn-proof a { color: var(--a); text-decoration: none; }
      .axn-proof a:hover { text-decoration: underline; }
      .axn-foot { margin-top: 0.9rem; font-size: 0.72rem; line-height: 1.5; color: var(--ink3); }
    `}</style>
  );
}
