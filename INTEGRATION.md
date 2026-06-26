# AXIS AI — Integration Guide

How the six packages fit together into one Proof-of-AI-Work protocol.

```
                        ┌──────────────────────────┐
   Telegram  ─────┐     │       API GATEWAY        │
   WhatsApp  ─────┼────▶│  auth · rate-limit ·     │────┐
   Direct API ────┘     │  nonce · audit (Fastify) │    │
                        └──────────────────────────┘    │
                                                         ▼
                                           ┌──────────────────────────┐
                                           │   VERIFICATION ENGINE     │
                                           │  pipeline · scoring ·     │
                          ┌───────────────▶│  Bull worker (Express)    │
                          │  POST /score   └────────────┬─────────────┘
                          │                              │ submitWork (mint)
              ┌───────────┴──────────┐                   ▼
              │     MARKETPLACE      │         ┌──────────────────────┐
              │  models · jobs ·     │ escrow  │   SMART CONTRACTS     │
              │  capacity · pricing ·│────────▶│ AXISToken ·           │
              │  escrow · reputation │         │ ValidatorRegistry ·   │
              └──────────────────────┘         │ MarketplaceEscrow     │
                                               └──────────────────────┘

           Shared: PostgreSQL (users, miners, submissions, marketplace)
                   Redis (cooldowns, nonces, sessions, queues, pricing)
```

## 1. How the contract address flows into all services

1. `packages/contracts/scripts/deploy.js` deploys `ValidatorRegistry`,
   `AXISToken` and `MarketplaceEscrow` (in that order) and writes:
   * `packages/contracts/deployments/<network>.json` (manifest)
   * `packages/contracts/deployments/<network>.env` with
     `AXIS_TOKEN_ADDRESS`, `VALIDATOR_REGISTRY_ADDRESS`,
     `MARKETPLACE_ESCROW_ADDRESS`, `DEPLOY_CHAIN_ID`.
2. `start.sh` merges that fragment into the root `./.env`.
3. Every service reads those variables from the environment:
   * **Engine** → `AXIS_TOKEN_ADDRESS` (reads difficulty/epoch/preview),
     `VALIDATOR_REGISTRY_ADDRESS` + `VALIDATOR_PRIVATE_KEY` (submits/mints).
   * **Marketplace** → `AXIS_TOKEN_ADDRESS`, `MARKETPLACE_ESCROW_ADDRESS`,
     `MARKETPLACE_PRIVATE_KEY` (escrow settlement).
   * **Bots** → only need `GATEWAY_URL` + `RPC_URL` (read block height for the
     nonce); they never touch the token directly.

## 2. How the verification engine connects to the marketplace

* The marketplace **does not re-implement scoring**. On `POST /jobs/:id/deliver`
  it calls the engine's scoring-only endpoint **`POST /score`**
  (`ENGINE_URL` in the marketplace env), which runs the exact same work-type
  scoring functions used for mining — but **without minting**.
* The returned quality drives escrow settlement:
  * quality ≥ `JOB_MIN_QUALITY` → `escrow.release` to the provider;
  * quality < `JOB_MIN_QUALITY` → `escrow.refund` to the requester;
  * quality < 0.2 → `escrow.flagFraud` (refund + provider flagged).

## 3. How both bots connect to the engine and marketplace

* The Telegram bot and WhatsApp agent **only talk to the API Gateway**
  (`GATEWAY_URL`). Nothing reaches the engine without passing through the
  gateway (auth, cross-channel rate-limit, nonce, DDoS, audit).
* Each bot derives a **deterministic mining wallet** per channel user
  (`BOT_SIGNER_SECRET` — identical for both bots so a user has one identity
  across channels) and signs:
  * submissions with the canonical `AXIS-POAIW-SUBMISSION|…` message;
  * gateway read-auth with `AXIS-GATEWAY-AUTH|…`.
* Both bots **share the same PostgreSQL `users` and `miners` tables** (created by
  the engine migration), so a wallet's stats are consistent everywhere.
* The marketplace is consumed directly (REST/Swagger) by providers/requesters;
  the bots focus on mining.

## 4. Local development startup sequence

```bash
# 0. Prereqs: Node 20+, Docker, npm.
cp .env.example .env          # fill TELEGRAM_BOT_TOKEN / META_* if using bots
npm install                   # installs all workspaces (+ links @axis/shared)

# 1. One command does everything (infra → deploy → migrate → start):
./start.sh                    # docker services
#   or
./start.sh --native           # infra in docker, Node services natively

# --- Manual equivalent --------------------------------------------------- #
# 1. Start infra
docker-compose up -d postgres redis hardhat
# 2. Deploy contracts (writes deployments/localhost.env)
npm --workspace @axis/contracts run deploy:local
#    then copy AXIS_TOKEN_ADDRESS / VALIDATOR_REGISTRY_ADDRESS /
#    MARKETPLACE_ESCROW_ADDRESS into .env
# 3. Migrate
npm run migrate:all
# 4. Start services (separate terminals)
npm run start:engine
npm run start:gateway
npm run start:marketplace
npm run start:telegram      # optional
npm run start:whatsapp      # optional
```

Verify:
* Engine: `curl localhost:4000/health`
* Gateway: `curl localhost:3000/health`
* Marketplace docs: `http://localhost:5000/docs`

End-to-end mining smoke test (engine directly):
```bash
node packages/engine/tools/sign-submission.js \
  0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  inference_text '{"text":"the inference output is coherent relevant and accurate"}' > sub.json
curl -X POST localhost:4000/submit -H 'Content-Type: application/json' -d @sub.json
```

## 5. Production deployment sequence

1. **Contracts**
   * Set `RPC_URL`, `CHAIN_ID`, `DEPLOYER_PRIVATE_KEY`, `INITIAL_VALIDATORS`,
     `ETHERSCAN_API_KEY` in `.env`.
   * `HARDHAT_NETWORK=custom npm --workspace @axis/contracts run deploy`
   * Verify on the explorer (see `README_CONTRACT.md`).
   * Copy the deployed addresses into the production secrets store.
2. **Validators** — ensure the engine's `VALIDATOR_PRIVATE_KEY` (and the
   marketplace's `MARKETPLACE_PRIVATE_KEY`) belong to addresses in the
   `ValidatorRegistry`. Add more validators via supermajority proposals.
3. **Data stores** — provision managed PostgreSQL + Redis; run `npm run migrate:all`.
4. **Engine** — deploy API + worker (scale the worker horizontally with
   `npm run worker`). Point at the token + registry.
5. **Gateway** — deploy in front of the engine; set strict rate limits.
6. **Marketplace** — deploy with `ENGINE_URL` pointing at the engine and
   `ESCROW_ONCHAIN=true` once requesters lock funds on-chain.
7. **Bots** — Telegram in **webhook** mode (`TELEGRAM_WEBHOOK_DOMAIN`), WhatsApp
   with the Meta webhook configured to the public `/webhook` URL. Both point at
   the gateway and share `BOT_SIGNER_SECRET`.
8. **Observability** — every service logs via Winston; scrape `/health`
   endpoints for liveness.

## Service port map

| Service | Port | Health / Docs |
|---|---|---|
| Hardhat node | 8545 | JSON-RPC |
| Verification engine | 4000 | `/health` |
| API gateway | 3000 | `/health` |
| Marketplace | 5000 | `/health`, `/docs` |
| Telegram bot | 8080 | (webhook) |
| WhatsApp agent | 8090 | `/health`, `/webhook` |
| PostgreSQL | 5432 | — |
| Redis | 6379 | — |
