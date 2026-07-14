"use client";

import { type ReactNode, useEffect } from "react";
import { Link } from "vocs";
import {
  AXIS_GENESIS_SUPPLY,
  AXIS_MAX_SUPPLY,
  EPOCHS,
  WORK_TYPES,
} from "../lib/axis";
import { AnalyticsEvents, captureEvent } from "../lib/posthog";
import { WorkIcon } from "./WorkIcons";

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

const JSON_LD = JSON.stringify([
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "AXIS AI",
    alternateName: "AXIS Proof-of-AI-Work Protocol",
    url: "https://axis.ai",
    description:
      "AXIS turns verifiable AI computation into a mineable digital commodity.",
  },
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "AXIS AI",
    url: "https://axis.ai",
  },
]);

// ---------------------------------------------------------------------------
// Landing page (exported)
// ---------------------------------------------------------------------------

export function LandingPage() {
  useEffect(() => {
    // Scroll-to-top on logo click.
    const logoLink = document.querySelector(
      "[data-v-logo] a",
    ) as HTMLAnchorElement | null;
    const onLogo = (e: MouseEvent) => {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: "smooth" });
    };
    logoLink?.addEventListener("click", onLogo);

    // Progressive scroll-reveal (content is visible without JS).
    document.documentElement.classList.add("ax-js");
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -6% 0px" },
    );
    const reveals = document.querySelectorAll(".ax-reveal");
    reveals.forEach((el) => {
      io.observe(el);
    });

    return () => {
      logoLink?.removeEventListener("click", onLogo);
      io.disconnect();
    };
  }, []);

  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD structured data
        dangerouslySetInnerHTML={{ __html: JSON_LD }}
      />
      <div className="not-prose landing">
        <LandingStyles />
        <div className="ax-canvas" aria-hidden="true" />

        <Hero />
        <Metrics />
        <HowItWorks />
        <WorkTypes />
        <Emission />
        <Closing />
        <Footer />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Hero — editorial two-column
// ---------------------------------------------------------------------------

function Hero() {
  return (
    <section className="ax-hero">
      <Corners />
      <div className="ax-hero-grid">
        <div className="ax-hero-copy">
          <span className="ax-pill">
            <span className="ax-pill-dot" />
            Genesis mining · Live
          </span>

          <h1 className="ax-display">
            Mine
            <br />
            intelligence.
          </h1>

          <p className="ax-lede">
            AXIS turns real AI work into something you can mine. Run inference,
            training, or validation and earn <span className="ax-em">AXIS</span>{" "}
            right in your browser.
          </p>

          <div className="ax-actions">
            <Link
              to="/wallet"
              className="ax-btn ax-btn-solid"
              onClick={() =>
                captureEvent(AnalyticsEvents.LANDING_CTA_CLICKED, {
                  cta_label: "Start mining",
                  href: "/wallet",
                })
              }
            >
              Start mining
              <Arrow />
            </Link>
            <Link
              to="/whitepaper"
              className="ax-btn ax-btn-line"
              onClick={() =>
                captureEvent(AnalyticsEvents.LANDING_CTA_CLICKED, {
                  cta_label: "Read the whitepaper",
                  href: "/whitepaper",
                })
              }
            >
              Read the whitepaper
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Metrics — hairline row
// ---------------------------------------------------------------------------

function Metrics() {
  const items = [
    { v: AXIS_MAX_SUPPLY.toLocaleString(), l: "Fixed supply" },
    { v: AXIS_GENESIS_SUPPLY.toLocaleString(), l: "Genesis phase" },
    { v: String(WORK_TYPES.length), l: "Work types" },
    { v: "0%", l: "Premine · founder" },
  ];
  return (
    <section className="ax-metrics ax-reveal">
      {items.map((it) => (
        <div key={it.l} className="ax-metric">
          <span className="ax-metric-v">{it.v}</span>
          <span className="ax-metric-l">{it.l}</span>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// How it works
// ---------------------------------------------------------------------------

const STEPS = [
  {
    n: "01",
    t: "Get a wallet",
    b: "A mining key is made right in your browser. No signup, no account, and nobody else holds your funds.",
  },
  {
    n: "02",
    t: "Do AI work",
    b: "Run inference, training, labeling, or validation. Your result gets signed and sent to the network.",
  },
  {
    n: "03",
    t: "Earn AXIS",
    b: "Work that checks out mints AXIS on the spot. The protocol sets the reward and nobody can change it.",
  },
];

function HowItWorks() {
  return (
    <Section
      index="01"
      eyebrow="How it works"
      title="Useful work, not wasted power"
      lede="Old mining burns electricity on puzzles that mean nothing. AXIS mines by doing real AI work, so every job you finish is actually worth something."
    >
      <div className="ax-steps">
        {STEPS.map((s) => (
          <article key={s.n} className="ax-step ax-reveal">
            <span className="ax-step-n">/ {s.n}</span>
            <h3 className="ax-step-t">{s.t}</h3>
            <p className="ax-step-b">{s.b}</p>
          </article>
        ))}
      </div>
      <div className="ax-formula ax-reveal">
        <span className="ax-formula-label">Reward function</span>
        <span className="ax-formula-eq">
          AXIS<span className="ax-op"> = </span>
          <span className="ax-var">W</span>
          <span className="ax-op"> × </span>
          <span className="ax-var">Q</span>
          <span className="ax-op"> ÷ </span>
          <span className="ax-var">D</span>
        </span>
        <span className="ax-formula-legend">
          workload · quality · difficulty
        </span>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Work types
// ---------------------------------------------------------------------------

function WorkTypes() {
  return (
    <Section
      index="02"
      eyebrow="Proof-of-AI-Work"
      title="Seven ways to mine"
      lede="Every submission gets scored automatically and checked against other miners before any AXIS is paid out."
    >
      <div className="ax-works">
        {WORK_TYPES.map((w, i) => (
          <article key={w.id} className="ax-work ax-reveal">
            <div className="ax-work-top">
              <span className="ax-work-icon">
                <WorkIcon id={w.id} />
              </span>
              <span className="ax-work-idx">
                {String(i + 1).padStart(2, "0")}
              </span>
            </div>
            <h3 className="ax-work-t">{w.label}</h3>
            <p className="ax-work-b">{w.instructions}</p>
          </article>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

function Emission() {
  const max = AXIS_MAX_SUPPLY;
  return (
    <Section
      index="03"
      eyebrow="Token economics"
      title="A fixed and predictable supply"
    >
      <div className="ax-emit ax-reveal">
        <div className="ax-emit-head">
          <span>Epoch</span>
          <span>Reward / block</span>
          <span className="ax-hide-sm">Cumulative</span>
          <span className="ax-emit-bar-h">Share of supply</span>
        </div>
        {EPOCHS.map((e, i) => {
          const prev = i === 0 ? 0 : EPOCHS[i - 1].cumulativeEnd;
          const pct = (e.cumulativeEnd / max) * 100;
          const genesis = e.name.startsWith("Genesis");
          return (
            <div key={e.name} className="ax-emit-row">
              <span className="ax-emit-name">
                {e.name}
                {genesis && <span className="ax-chip">genesis</span>}
              </span>
              <span className="ax-num">{e.baseReward} AXIS</span>
              <span className="ax-num ax-dim ax-hide-sm">
                {(prev / 1_000_000).toFixed(2)}M to{" "}
                {(e.cumulativeEnd / 1_000_000).toFixed(2)}M
              </span>
              <span className="ax-emit-bar-c">
                <span className="ax-bar">
                  <span className="ax-bar-fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="ax-num ax-dim ax-bar-pct">
                  {pct.toFixed(0)}%
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

function Closing() {
  return (
    <section className="ax-closing ax-reveal">
      <Corners />
      <img
        className="ax-closing-mark"
        src="/logo.png"
        alt=""
        aria-hidden="true"
      />
      <span className="ax-eyebrow">Open · Permissionless · Verifiable</span>
      <h2 className="ax-closing-t">Mine it. Own it. Trade it.</h2>
      <p className="ax-closing-b">
        Every AXIS is earned by real AI work. The rules were set at launch and
        can't be changed. There's no central issuer, no admin keys, and no one
        who can print more.
      </p>
      <div className="ax-actions ax-actions-center">
        <Link
          to="/wallet"
          className="ax-btn ax-btn-solid"
          onClick={() =>
            captureEvent(AnalyticsEvents.LANDING_CTA_CLICKED, {
              cta_label: "Start mining (closing)",
              href: "/wallet",
            })
          }
        >
          Start mining
          <Arrow />
        </Link>
        <Link to="/overview" className="ax-btn ax-btn-line">
          How mining works
        </Link>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function Footer() {
  return (
    <footer className="ax-footer">
      <div className="ax-footer-grid">
        <div className="ax-footer-brand">
          <span className="ax-foot-mark">
            <img src="/logo.png" alt="AXIS AI" />
          </span>
          <span className="ax-foot-word">
            AXIS<span className="ax-foot-ai">AI</span>
          </span>
          <p className="ax-foot-tag">The commodity layer for AI computation.</p>
        </div>

        <div className="ax-foot-col">
          <span className="ax-foot-h">Protocol</span>
          <Link to="/overview">Overview</Link>
          <Link to="/whitepaper">Whitepaper</Link>
          <Link to="/faq">FAQ</Link>
        </div>

        <div className="ax-foot-col">
          <span className="ax-foot-h">Resources</span>
          <a
            href="https://github.com/alexcarus/axisai"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <a href="https://x.com/axismyai" target="_blank" rel="noreferrer">
            X / Twitter
          </a>
        </div>
      </div>
      <div className="ax-footer-base">
        <span>© 2026 AXIS · fair launch, no premine</span>
        <span className="ax-foot-supply">84,000,000 AXIS · fixed forever</span>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Section({
  index,
  eyebrow,
  title,
  lede,
  children,
}: {
  index: string;
  eyebrow: string;
  title: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <section className="ax-section">
      <div className="ax-sec-head ax-reveal">
        <span className="ax-eyebrow">
          <span className="ax-eyebrow-idx">{index}</span>
          {eyebrow}
        </span>
        <h2 className="ax-h2">{title}</h2>
        {lede && <p className="ax-lede ax-lede-narrow">{lede}</p>}
      </div>
      {children}
    </section>
  );
}

function Corners() {
  return (
    <div className="ax-corners" aria-hidden="true">
      <span /> <span /> <span /> <span />
    </div>
  );
}

function Arrow() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className="ax-arrow"
    >
      <path
        d="M3 7h8M7.5 3.5L11 7l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Axis mark — crossing axes through a node.
// ---------------------------------------------------------------------------
// Scoped styles
// ---------------------------------------------------------------------------

function LandingStyles() {
  return (
    <style>{`
      /* ===== Vocs chrome ===== */
      :has(.landing) [data-v-logo] { display: flex !important; align-items: center !important; gap: 0.7rem !important; }
      :has(.landing) [data-v-main] { padding: 0 !important; margin: 0 !important; }
      :has(.landing) [data-v-main] article[data-v-content] { padding: 0 !important; margin: 0 !important; max-width: none !important; }
      :has(.landing) [data-v-main] article[data-v-content] > * { margin-top: 0 !important; }
      :has(.landing) [data-v-gutter-top] { position: sticky !important; top: 0 !important; z-index: 200 !important; }
      :has(.landing) [data-v-content] a { text-decoration: none !important; }
      :has(.landing) [data-v-main]::after { display: none; }
      :has(.landing) [data-v-gutter-top],
      :has(.landing) [data-v-header],
      :has(.landing) header {
        background: color-mix(in oklab, var(--vocs-background-color-primary) 72%, transparent) !important;
        backdrop-filter: blur(14px) saturate(1.4) !important;
        -webkit-backdrop-filter: blur(14px) saturate(1.4) !important;
        border-bottom: 1px solid var(--ax-line) !important;
        box-shadow: none !important;
      }

      /* ===== Tokens ===== */
      .landing {
        --ink: var(--vocs-text-color-heading);
        --ink-2: var(--vocs-text-color-secondary);
        --ink-3: var(--vocs-text-color-muted);
        --line: light-dark(rgba(9,9,11,0.12), rgba(255,255,255,0.10));
        --line-soft: light-dark(rgba(9,9,11,0.06), rgba(255,255,255,0.05));
        --surface: light-dark(rgba(9,9,11,0.022), rgba(255,255,255,0.018));
        --surface-2: light-dark(#ffffff, rgba(255,255,255,0.028));
        --lime: #eef2f9;
        --lime-ink: light-dark(#5b6577, #ced8ec);
        --lime-soft: light-dark(rgba(90,101,119,0.10), rgba(150,170,210,0.16));
        --live: #7fe0a8;
        --maxw: 1160px;
        --pad: clamp(1.25rem, 5vw, 3rem);
        color: var(--ink);
        font-family: var(--font-sans);
        font-feature-settings: "ss01", "cv01", "tnum";
        margin-top: 0 !important;
        position: relative;
        isolation: isolate;
      }

      /* ===== Background canvas (fixed) ===== */
      .ax-canvas {
        position: fixed; inset: 0; z-index: -1; pointer-events: none;
        background:
          radial-gradient(120% 80% at 50% -20%, var(--lime-soft) 0%, transparent 42%),
          var(--vocs-background-color-primary);
      }
      .ax-canvas::before {
        content: ""; position: absolute; inset: 0;
        background-image:
          linear-gradient(var(--line-soft) 1px, transparent 1px),
          linear-gradient(90deg, var(--line-soft) 1px, transparent 1px);
        background-size: 64px 64px;
        mask-image: radial-gradient(120% 90% at 50% 0%, #000 0%, transparent 70%);
        -webkit-mask-image: radial-gradient(120% 90% at 50% 0%, #000 0%, transparent 70%);
        opacity: 0.14;
      }
      .ax-canvas::after {
        content: ""; position: absolute; inset: 0; opacity: light-dark(0.025, 0.04);
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
        mix-blend-mode: overlay;
      }

      /* ===== Reveal ===== */
      .ax-js .ax-reveal { opacity: 0; transform: translateY(16px); transition: opacity .7s cubic-bezier(.16,1,.3,1), transform .7s cubic-bezier(.16,1,.3,1); }
      .ax-js .ax-reveal.is-in { opacity: 1; transform: none; }
      @media (prefers-reduced-motion: reduce) { .ax-js .ax-reveal { opacity: 1 !important; transform: none !important; transition: none; } }

      /* ===== Typography helpers ===== */
      .ax-eyebrow {
        display: inline-flex; align-items: center; gap: 0.6rem;
        font-family: var(--font-mono); font-size: 0.72rem; letter-spacing: 0.18em;
        text-transform: uppercase; color: var(--ink-3); font-weight: 500;
      }
      .ax-eyebrow-idx { color: var(--lime-ink); }
      .ax-h2 {
        font-size: clamp(1.85rem, 3.6vw, 2.9rem); font-weight: 600; line-height: 1.04;
        letter-spacing: -0.03em; color: var(--ink); margin: 0;
      }
      .ax-lede { font-size: clamp(1rem, 1.5vw, 1.16rem); line-height: 1.6; color: var(--ink-2); margin: 0; }
      .ax-lede-narrow { max-width: 56ch; }
      .ax-em { color: var(--ink); font-weight: 600; }
      .ax-num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
      .ax-dim { color: var(--ink-3); }

      /* ===== Buttons ===== */
      .ax-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.7rem; }
      .ax-actions-center { justify-content: center; }
      .ax-btn {
        display: inline-flex; align-items: center; gap: 0.5rem;
        height: 46px; padding: 0 1.2rem; border-radius: 8px;
        font-size: 0.94rem; font-weight: 550; letter-spacing: -0.01em;
        cursor: pointer; border: 1px solid transparent; white-space: nowrap;
        text-decoration: none !important;
        transition: transform .18s cubic-bezier(.16,1,.3,1), background .18s ease, border-color .18s ease, color .18s ease;
      }
      .ax-btn-solid { color: #0a0c10; background: var(--lime); border-color: var(--lime); }
      .ax-btn-solid:hover { transform: translateY(-1px); background: color-mix(in oklab, var(--lime) 88%, #fff); }
      .ax-btn-line { color: var(--ink); background: var(--surface-2); border-color: var(--line); }
      .ax-btn-line:hover { border-color: var(--ink-3); transform: translateY(-1px); }
      .ax-arrow { transition: transform .2s ease; }
      .ax-btn:hover .ax-arrow { transform: translateX(2px); }

      /* ===== Corner ticks ===== */
      .ax-corners > span { position: absolute; width: 9px; height: 9px; opacity: 0.5; }
      .ax-corners > span::before, .ax-corners > span::after { content: ""; position: absolute; background: var(--ink-3); }
      .ax-corners > span::before { width: 9px; height: 1px; top: 4px; }
      .ax-corners > span::after { width: 1px; height: 9px; left: 4px; }
      .ax-corners > span:nth-child(1) { top: -1px; left: -1px; }
      .ax-corners > span:nth-child(2) { top: -1px; right: -1px; }
      .ax-corners > span:nth-child(3) { bottom: -1px; left: -1px; }
      .ax-corners > span:nth-child(4) { bottom: -1px; right: -1px; }

      /* ===== Hero ===== */
      .ax-hero {
        position: relative; max-width: var(--maxw); margin: 0 auto;
        padding: clamp(3rem, 9vh, 6rem) var(--pad) clamp(2.5rem, 6vh, 4rem);
      }
      .ax-hero-grid {
        display: grid; grid-template-columns: 1fr; gap: clamp(2rem, 4vw, 3.5rem);
        align-items: center;
      }
      .ax-hero-copy { display: flex; flex-direction: column; gap: clamp(1.1rem, 2.2vw, 1.6rem); }
      .ax-pill {
        align-self: flex-start; display: inline-flex; align-items: center; gap: 0.5rem;
        font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase;
        color: var(--ink-2); padding: 0.34rem 0.7rem; border: 1px solid var(--line);
        border-radius: 999px; background: var(--surface);
      }
      .ax-pill-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--live); box-shadow: 0 0 0 3px rgba(127,224,168,0.16); }
      .ax-display {
        margin: 0; font-weight: 600; letter-spacing: -0.045em; line-height: 0.92;
        font-size: clamp(3.4rem, 9vw, 6.4rem); color: var(--ink);
      }
      .ax-lede { max-width: 46ch; }
      .ax-trust {
        display: flex; flex-wrap: wrap; gap: 0.5rem 1.4rem; margin: 0.4rem 0 0; padding: 0; list-style: none;
        font-family: var(--font-mono); font-size: 0.72rem; letter-spacing: 0.04em; color: var(--ink-3); text-transform: uppercase;
      }
      .ax-trust li { display: flex; align-items: center; gap: 0.5rem; }
      .ax-trust li::before { content: ""; width: 4px; height: 4px; border-radius: 50%; background: var(--lime-ink); }

      /* ===== Hero panel (miner) ===== */
      .ax-hero-panel {
        position: relative; border: 1px solid var(--line); border-radius: 14px; overflow: hidden;
        background: light-dark(#ffffff, #101217);
        box-shadow: 0 40px 90px -60px light-dark(rgba(0,0,0,0.4), rgba(0,0,0,0.9)), inset 0 1px 0 light-dark(rgba(255,255,255,0.8), rgba(255,255,255,0.04));
        max-width: 540px; width: 100%; justify-self: end;
      }
      .ax-panel-chrome {
        display: flex; align-items: center; justify-content: space-between;
        padding: 0.6rem 0.9rem; border-bottom: 1px solid var(--line-soft);
        background: light-dark(rgba(9,9,11,0.015), rgba(255,255,255,0.014));
      }
      .ax-panel-title { display: inline-flex; align-items: center; gap: 0.5rem; font-family: var(--font-mono); font-size: 0.72rem; letter-spacing: 0.06em; color: var(--ink-2); }
      .ax-panel-live { width: 7px; height: 7px; border-radius: 50%; background: var(--live); box-shadow: 0 0 8px var(--live); animation: axLive 1.6s ease-in-out infinite; }
      @keyframes axLive { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
      .ax-panel-meta { font-family: var(--font-mono); font-size: 0.66rem; letter-spacing: 0.08em; color: var(--ink-3); text-transform: uppercase; }
      .ax-panel-body { height: clamp(468px, 62vh, 580px); }

      /* ===== Metrics ===== */
      .ax-metrics {
        max-width: var(--maxw); margin: clamp(1rem, 4vh, 2.5rem) auto 0;
        display: grid; grid-template-columns: repeat(4, 1fr);
        border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
      }
      .ax-metric { padding: clamp(1.4rem, 3vw, 2.2rem) var(--pad); border-left: 1px solid var(--line-soft); }
      .ax-metric:first-child { border-left: none; }
      .ax-metric-v { display: block; font-family: var(--font-mono); font-weight: 500; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; font-size: clamp(1.15rem, 2.4vw, 1.9rem); color: var(--ink); }
      .ax-metric-l { display: block; margin-top: 0.4rem; font-size: 0.74rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink-3); }
      @media (max-width: 640px) {
        .ax-metrics { grid-template-columns: 1fr 1fr; }
        .ax-metric:nth-child(3) { border-left: none; }
        .ax-metric:nth-child(-n+2) { border-bottom: 1px solid var(--line-soft); }
      }

      /* ===== Sections ===== */
      .ax-section { max-width: var(--maxw); margin: 0 auto; padding: clamp(4rem, 11vh, 8rem) var(--pad) 0; }
      .ax-section:last-of-type { padding-bottom: clamp(2rem, 6vh, 4rem); }
      .ax-sec-head { max-width: 60ch; margin-bottom: clamp(2rem, 4vh, 3rem); display: flex; flex-direction: column; gap: 1rem; }
      .ax-eyebrow-idx { margin-right: 0.1rem; }

      /* ===== Steps ===== */
      .ax-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
      .ax-step { background: var(--vocs-background-color-primary); padding: clamp(1.5rem, 2.6vw, 2.1rem); }
      .ax-step-n { font-family: var(--font-mono); font-size: 0.74rem; letter-spacing: 0.06em; color: var(--lime-ink); }
      .ax-step-t { font-size: 1.12rem; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); margin: 1.6rem 0 0.5rem; }
      .ax-step-b { font-size: 0.92rem; line-height: 1.6; color: var(--ink-2); margin: 0; }
      @media (max-width: 760px) { .ax-steps { grid-template-columns: 1fr; } }

      .ax-formula {
        margin-top: 1px; display: flex; align-items: center; justify-content: center; gap: 1.2rem; flex-wrap: wrap;
        padding: 1.2rem; border: 1px solid var(--line); border-radius: 12px; background: var(--surface);
      }
      .ax-formula-label, .ax-formula-legend { font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
      .ax-formula-eq { font-family: var(--font-mono); font-size: clamp(1.1rem, 2vw, 1.5rem); color: var(--ink); letter-spacing: 0.02em; }
      .ax-var { color: var(--lime-ink); }
      .ax-op { color: var(--ink-3); }

      /* ===== Work types ===== */
      .ax-works { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
      .ax-work { background: var(--vocs-background-color-primary); padding: clamp(1.3rem, 2.2vw, 1.7rem); transition: background .2s ease; }
      .ax-work:hover { background: var(--surface-2); }
      .ax-work-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.4rem; }
      .ax-work-icon { display: inline-flex; width: 40px; height: 40px; align-items: center; justify-content: center; border: 1px solid var(--line); border-radius: 9px; color: var(--ink); background: var(--surface); }
      .ax-work:hover .ax-work-icon { color: var(--lime-ink); border-color: var(--lime-ink); }
      .ax-work-idx { font-family: var(--font-mono); font-size: 0.72rem; color: var(--ink-3); }
      .ax-work-t { font-size: 1.02rem; font-weight: 600; letter-spacing: -0.01em; color: var(--ink); margin: 0 0 0.45rem; }
      .ax-work-b { font-size: 0.86rem; line-height: 1.55; color: var(--ink-2); margin: 0; }
      @media (max-width: 980px) { .ax-works { grid-template-columns: repeat(2, 1fr); } }
      @media (max-width: 560px) { .ax-works { grid-template-columns: 1fr; } }

      /* ===== Emission ===== */
      .ax-emit { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
      .ax-emit-head, .ax-emit-row { display: grid; grid-template-columns: 1.2fr 1fr 1.4fr 1.5fr; align-items: center; gap: 1.2rem; padding: 1rem clamp(1rem, 2vw, 1.5rem); }
      .ax-emit-head { font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); background: var(--surface); border-bottom: 1px solid var(--line); }
      .ax-emit-row { border-bottom: 1px solid var(--line-soft); transition: background .15s ease; }
      .ax-emit-row:last-child { border-bottom: none; }
      .ax-emit-row:hover { background: var(--surface); }
      .ax-emit-name { display: inline-flex; align-items: center; gap: 0.55rem; font-weight: 550; color: var(--ink); }
      .ax-chip { font-family: var(--font-mono); font-size: 0.56rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--lime-ink); border: 1px solid var(--lime-ink); border-radius: 999px; padding: 1px 7px; }
      .ax-emit-bar-c { display: flex; align-items: center; gap: 0.7rem; }
      .ax-bar { flex: 1; height: 5px; border-radius: 999px; background: var(--line); overflow: hidden; }
      .ax-bar-fill { display: block; height: 100%; background: linear-gradient(90deg, color-mix(in oklab, var(--lime) 70%, var(--ink-3)), var(--lime)); border-radius: 999px; }
      .ax-bar-pct { min-width: 2.5ch; text-align: right; font-size: 0.78rem; }
      @media (max-width: 720px) {
        .ax-emit-head, .ax-emit-row { grid-template-columns: 1fr auto; gap: 0.4rem 1rem; }
        .ax-hide-sm { display: none; }
        .ax-emit-bar-c { grid-column: 1 / -1; }
      }

      /* ===== Closing ===== */
      .ax-closing {
        position: relative; max-width: var(--maxw); margin: clamp(4rem, 11vh, 8rem) auto 0;
        padding: clamp(3rem, 8vw, 6rem) var(--pad); text-align: center;
        display: flex; flex-direction: column; align-items: center; gap: 1.2rem;
        border: 1px solid var(--line); border-radius: 18px; overflow: hidden;
        background:
          radial-gradient(90% 120% at 50% -30%, var(--lime-soft), transparent 55%),
          var(--surface);
      }
      .ax-closing-mark { width: 66px; height: 66px; border-radius: 15px; margin-bottom: 6px; box-shadow: 0 12px 44px rgba(150,170,210,0.20); }
      .ax-closing-t { margin: 0; font-size: clamp(2.1rem, 5vw, 3.6rem); font-weight: 600; letter-spacing: -0.04em; line-height: 1; color: var(--ink); }
      .ax-closing-b { margin: 0; max-width: 54ch; font-size: clamp(0.98rem, 1.5vw, 1.1rem); line-height: 1.6; color: var(--ink-2); }

      /* ===== Footer ===== */
      .ax-footer { max-width: var(--maxw); margin: clamp(3rem, 7vh, 5rem) auto 0; padding: clamp(2.5rem, 5vw, 4rem) var(--pad) 2.5rem; border-top: 1px solid var(--line); }
      .ax-footer-grid { display: grid; grid-template-columns: 1.6fr 1fr 1fr; gap: 2.5rem; }
      .ax-footer-brand { display: flex; flex-direction: column; gap: 0.5rem; }
      .ax-foot-mark { width: 30px; height: 30px; color: var(--ink); }
      .ax-foot-mark img { width: 30px; height: 30px; border-radius: 6px; object-fit: cover; display: block; }
      .ax-foot-word { font-weight: 700; letter-spacing: -0.02em; font-size: 1.25rem; display: inline-flex; align-items: baseline; gap: 0.25rem; }
      .ax-foot-ai { font-size: 0.6em; color: var(--lime-ink); letter-spacing: 0.1em; }
      .ax-foot-tag { margin: 0.3rem 0 0; font-size: 0.88rem; color: var(--ink-3); max-width: 30ch; }
      .ax-foot-col { display: flex; flex-direction: column; gap: 0.7rem; }
      .ax-foot-h { font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-3); margin-bottom: 0.2rem; }
      .ax-foot-col a { font-size: 0.92rem; color: var(--ink-2); text-decoration: none !important; transition: color .15s ease; width: fit-content; }
      .ax-foot-col a:hover { color: var(--lime-ink); }
      .ax-footer-base { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-top: clamp(2rem, 4vw, 3rem); padding-top: 1.5rem; border-top: 1px solid var(--line-soft); font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.04em; color: var(--ink-3); }
      @media (max-width: 720px) { .ax-footer-grid { grid-template-columns: 1fr 1fr; } .ax-footer-brand { grid-column: 1 / -1; } }
    `}</style>
  );
}
