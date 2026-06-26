# AXIS AI — Security Review & Hardening

This document records a live attack pass run against the full stack (contracts on
a Hardhat node, engine, gateway, marketplace) and the fixes applied.

Reproduce with the harness in [`tools/security/`](tools/security/): bring the
stack up (`./start.sh`), then `node tools/security/attack-suite.js`.

## Result

| # | Attack | Before | After |
|---|---|---|---|
| 1 | Gateway signature forgery / missing signature | blocked (401) | blocked (401) |
| 2 | Wallet-mismatch (sign as attacker, claim victim) | blocked (401) | blocked (401) |
| 3 | Cross-channel rate limit (Telegram → WhatsApp) | blocked (429) | blocked (429) |
| 4 | Gateway nonce / replay (identical body twice) | blocked (400) | blocked (400) |
| 5 | **Direct-engine replay → double-mint** | **VULNERABLE** | **fixed** |
| 6 | **Direct-engine cooldown griefing of a victim** | **VULNERABLE** | **fixed** |
| 7 | Reward inflation via oversized output (W) | capped (≤1000) | capped (≤1000) |
| 8 | Marketplace publish signature forgery | blocked (401) | blocked (401) |
| 9 | SQL injection (`/miner`, `/status`) | safe (parameterised) | safe |
| 10 | Gateway read-auth: stale / forged headers | blocked (401) | blocked (401) |
| 11 | DDoS IP ban after repeated violations | working (403) | working (403) |

The gateway controls all behaved correctly from the start. Two genuine
vulnerabilities were found in the **verification engine**, both because it was
directly reachable on its port and applied side-effects before a request was
proven authentic **and** fresh.

---

## Finding 1 — Replay / double-mint (Critical)

**What:** Replaying the *exact same signed submission body* to the engine
`POST /submit` minted AXIS again (observed: a wallet's balance went 136 → 272
from one unit of work). The submission signature is single-key, but the engine
never marked it consumed, so any captured valid submission could be replayed to
mint unlimited AXIS up to the cap — undermining the fairness of the fixed supply.

**Root cause:** No uniqueness/idempotency on submissions at the engine. The
gateway's nonce check only protected the gateway path; the directly-exposed
engine had no replay protection.

**Fix:**
- The submission `signature` is now stored and protected by a **`UNIQUE` index**
  (`idx_submissions_signature`). The `INSERT` is the atomic point of claim; a
  replay collides (Postgres error `23505`) and is rejected with **409**. This is
  atomic and correct even across horizontally-scaled engine instances.
- Files: `packages/engine/src/db/migrate.js` (column + unique index + `ALTER`
  upgrade path), `packages/engine/src/routes/submit.js` (insert-with-signature,
  `23505` → 409).

## Finding 2 — Cooldown griefing (High)

**What:** An attacker sent an invalid-signature submission to the engine that
*named a victim's `wallet_address`*. The worker rejected it for a bad signature
but applied the 60-second cooldown (and incremented submission counters) to the
**victim** — so an attacker could keep any wallet permanently locked out and
pollute its stats.

**Root cause:** The engine queued submissions and verified the signature *inside
the worker*, and the rejection path applied a cooldown regardless of whether the
caller actually owned the named wallet.

**Fix:**
- Authenticity (signature) and integrity (output-hash commitment) are now
  verified **synchronously in `POST /submit`, before any side-effect** — no DB
  row, no counter, no cooldown, no queue. Unauthenticated requests get **401**
  with zero side-effects. (`packages/engine/src/routes/submit.js`)
- Defense-in-depth: the pipeline's authenticity checks now reject **without** a
  cooldown (`rejectNoCooldown`); only genuine quality/fraud rejections by the
  authenticated owner apply a cooldown (the intended anti-spam behaviour).
  (`packages/engine/src/pipeline/verify.js`)

## Hardening — Engine internal-key guard (defense-in-depth)

Both findings were amplified by the engine being reachable directly, bypassing
the gateway's nonce / cross-channel rate-limit / audit controls. Added an
**optional shared-secret guard**: when `ENGINE_INTERNAL_KEY` is set, every
non-`/health` engine request must present a matching `x-internal-key` header. The
gateway and marketplace forward it automatically; the public internet cannot
reach the engine directly.

- Verified: with the key set, direct `POST /submit` and `POST /score` return
  **403**, `/health` stays **200**, and the gateway mining path still works
  end-to-end (gateway forwards the key).
- Files: `packages/engine/src/{config.js,server.js}`,
  `packages/gateway/src/{config.js,proxy.js}`,
  `packages/marketplace/src/{config.js,services/verification.js}`.
- Off by default (empty) for frictionless local dev; **set it in production.**

## Confirmed-good controls (no change needed)

- **On-chain integrity:** mint is registry-only; `W×Q÷D` and the 84,000,000 cap
  are enforced on-chain (Q clamped 0–100, W capped at 1000 off-chain, final mint
  clamped to remaining supply). A miner can only mint to a wallet it controls
  (signature-bound), never to an arbitrary address.
- **Gateway:** signature auth, wallet-keyed cross-channel cooldown, nonce
  consumption (`SET NX`), IP + wallet rate limits, automatic violation bans, and
  signed read-auth with a freshness window — all verified working.
- **SQL injection:** every query is parameterised; address inputs are validated
  with `ethers.isAddress`.
- **Marketplace:** all mutating endpoints require a signed canonical message
  recovering to the claimed wallet; capacity purchases use `SELECT … FOR UPDATE`.
- **Contracts:** `ReentrancyGuard` on external calls; no owner/admin/upgrade/pause.
