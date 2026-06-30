"use client";

import { useState } from "react";
import { answerFromSite } from "../lib/axis-bot";

// ---------------------------------------------------------------------------
// Ask AXIS — answers questions straight from the AXIS site's own content. It's
// a deterministic bot (no AI model, no backend call): it reads your question and
// replies with what this site documents about mining, supply, the markets and
// wallets. Informational only.
// ---------------------------------------------------------------------------

const SUGGESTIONS = [
  "What is AXIS AI and how does mining work?",
  "How do I start mining AXIS?",
  "What happens at 25% of supply?",
  "How does the compute marketplace work?",
];

export function AskAxisWidget({ className }: { className?: string }) {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);

  function ask(question: string) {
    const text = question.trim();
    if (!text) return;
    setAnswer(answerFromSite(text));
  }

  return (
    <div className={`aax ${className ?? ""}`}>
      <Styles />
      <div className="aax-bar">
        <span className="aax-dot" />
        <span className="aax-title">ask axis ai</span>
      </div>
      <div className="aax-body">
        <div className="aax-row">
          <input
            className="aax-input"
            value={q}
            placeholder="Ask anything about AXIS AI…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") ask(q);
            }}
          />
          <button
            type="button"
            className="aax-btn"
            onClick={() => ask(q)}
            disabled={!q.trim()}
          >
            Ask
          </button>
        </div>

        {!answer && (
          <div className="aax-sugg">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                className="aax-chip"
                onClick={() => {
                  setQ(s);
                  ask(s);
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {answer && <div className="aax-answer">{answer}</div>}
      </div>
      <div className="aax-foot">
        Answers come straight from this site's docs — informational only, not
        financial or investment advice.
      </div>
    </div>
  );
}

function Styles() {
  return (
    <style>{`
      .aax {
        --l: light-dark(rgba(9,9,11,0.10), rgba(255,255,255,0.09));
        --soft: light-dark(rgba(9,9,11,0.028), rgba(255,255,255,0.03));
        --lime: #cdf24e;
        --lime-ink: light-dark(#3f6b15, #cdf24e);
        --ink: var(--vocs-text-color-heading);
        --ink2: var(--vocs-text-color-secondary);
        --ink3: var(--vocs-text-color-muted);
        display: flex; flex-direction: column; width: 100%;
        border: 1px solid var(--l); border-radius: 14px; overflow: hidden;
        background: light-dark(rgba(255,255,255,0.5), rgba(255,255,255,0.012));
        font-family: var(--font-mono, "Geist Mono", monospace); color: var(--ink);
      }
      .aax-bar { display: flex; align-items: center; gap: 0.55rem; padding: 0.55rem 0.9rem; border-bottom: 1px solid var(--l); }
      .aax-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--lime); box-shadow: 0 0 7px var(--lime); }
      .aax-title { font-size: 11.5px; color: var(--ink3); letter-spacing: 0.1em; text-transform: uppercase; }
      .aax-body { display: flex; flex-direction: column; gap: 0.7rem; padding: 0.9rem; }
      .aax-row { display: flex; gap: 8px; }
      .aax-input { flex: 1; border: 1px solid var(--l); border-radius: 9px; padding: 9px 11px; background: var(--vocs-background-color-primary); color: var(--ink); font-family: inherit; font-size: 13px; outline: none; }
      .aax-btn { padding: 9px 16px; border-radius: 9px; font-size: 13px; font-weight: 700; cursor: pointer; border: 1px solid var(--lime); background: var(--lime); color: #0a0a0a; }
      .aax-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .aax-sugg { display: flex; flex-wrap: wrap; gap: 6px; }
      .aax-chip { font-size: 11px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--l); background: transparent; color: var(--ink2); cursor: pointer; }
      .aax-chip:hover { border-color: var(--lime-ink); color: var(--ink); }
      .aax-status { font-size: 12px; color: var(--lime-ink); }
      .aax-err { font-size: 12px; color: light-dark(#b91c1c, #f0857d); }
      .aax-answer { font-size: 13px; line-height: 1.65; color: var(--ink); white-space: pre-wrap; border: 1px solid var(--l); border-radius: 10px; padding: 11px 13px; background: var(--soft); max-height: 360px; overflow-y: auto; }
      .aax-foot { padding: 0.5rem 0.9rem; font-size: 10px; color: var(--ink3); border-top: 1px solid var(--l); }
    `}</style>
  );
}
