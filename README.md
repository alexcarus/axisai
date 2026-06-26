# AXIS AI — Proof-of-AI-Work Protocol

> *Mine it. Own it. Trade it. — AXIS AI is AI computation made free.*

AXIS AI turns AI computation into a mineable digital commodity. Participants earn
**AXIS** by contributing verifiable AI work (inference, training steps, dataset
labeling, synthetic data, peer validation). Supply is permanently fixed at
**84,000,000 AXIS** — no premine, no founder allocation, no treasury, no admin
keys. 100% is distributed through Proof-of-AI-Work mining.

This monorepo implements the full protocol.

## Packages

| Package | What it is |
|---|---|
| [`packages/contracts`](packages/contracts/README_CONTRACT.md) | Solidity: `AXISToken`, `ValidatorRegistry`, `MarketplaceEscrow` + Hardhat tests |
| [`packages/engine`](packages/engine/README_ENGINE.md) | PoAIW off-chain verification engine (Express + Bull + Postgres + Redis + Ethers) |
| [`packages/gateway`](packages/gateway/README_GATEWAY.md) | Fastify API gateway: auth, cross-channel rate-limit, nonce, DDoS, audit |
| [`packages/telegram-bot`](packages/telegram-bot/README_TELEGRAM.md) | Telegram mining interface (Telegraf) |
| [`packages/whatsapp-agent`](packages/whatsapp-agent/README_WHATSAPP.md) | WhatsApp mining agent (Meta Cloud API) |
| [`packages/marketplace`](packages/marketplace/README_MARKETPLACE.md) | Compute marketplace: models, jobs, capacity, pricing, escrow, reputation |
| `packages/shared` | Shared helpers (wallet derivation, signing, nonce, gateway client) |

## Token economics

```
AXIS Reward = baseEpochReward × (W × Q) / (D × 100)
```

| Epoch | Cumulative end | Base reward |
|---|---|---|
| Genesis 1 | 5,250,000 | 200 AXIS |
| Genesis 2 | 10,500,000 | 100 AXIS |
| Genesis 3 | 15,750,000 | 50 AXIS |
| Genesis 4 | 21,000,000 | 25 AXIS |
| Standard | 63,000,000 | 12.5 AXIS |
| Late | 79,800,000 | 6.25 AXIS |
| Terminal | 84,000,000 | 3.125 AXIS |

Epoch transitions are automatic (driven by `totalMinted`); minting is permanently
disabled at the 84,000,000 cap.

## Quick start

```bash
cp .env.example .env
npm install
./start.sh          # infra → deploy → migrate → start everything
```

See [INTEGRATION.md](INTEGRATION.md) for the full local and production sequences.

## Tests

```bash
npm run contracts:test
```

## Security

A live attack pass and the fixes applied are documented in
[SECURITY.md](SECURITY.md). Reproduce against a running stack with
[`tools/security/`](tools/security/):

```bash
./start.sh
node tools/security/mine-demo.js        # end-to-end mining smoke test
node tools/security/attack-suite.js     # adversarial regression suite (13 checks)
```

Set `ENGINE_INTERNAL_KEY` (same value on engine, gateway, marketplace) in
production so the engine is never reachable directly, only via the gateway.
