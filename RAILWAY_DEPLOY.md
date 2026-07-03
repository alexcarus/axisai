# AXIS AI — Railway deploy (backend off localhost)

Deploys the 3 services + Postgres + Redis on Railway from the GitHub repo. The
services now listen on Railway's `$PORT` and **self-migrate on deploy** (idempotent),
so this is mostly clicks. Web stays on Vercel; this is everything behind it.

Live Base mainnet contracts (already deployed):
```
AXIS_TOKEN_ADDRESS=0x65ECD6Df2eF1845B70A5c5c9c7E6Ed487d8e329D
VALIDATOR_REGISTRY_ADDRESS=0xcDbEb868D5955C04aD3A471388b5ebAeE65AcaE4
MARKETPLACE_ESCROW_ADDRESS=0xA9205dE579A21203CE5e29dAa1cCC6BC6434D699
DEPLOY_CHAIN_ID=8453
```

## 1. Project + databases
1. railway.com → **New Project → Deploy from GitHub repo** → `zenashwoldeyes-rgb/axisai`.
2. In the project: **+ New → Database → Add PostgreSQL**, then **+ New → Database → Add Redis**.

## 2. Create the 3 services (same repo, different root dir)
For each, **+ New → GitHub Repo → axisai**, then in the service's **Settings**:
| Service name | Root Directory | Public domain? |
|---|---|---|
| `axis-engine` | `packages/engine` | **No** (private — holds the validator key) |
| `axis-gateway` | `packages/gateway` | **Yes** (Settings → Networking → Generate Domain) |
| `axis-marketplace` | `packages/marketplace` | **Yes** (Generate Domain) |

Railway auto-detects each `railway.json` + `Dockerfile`.

## 3. Environment variables
Use Railway's **Variables → Reference** button to insert the `${{...}}` values.

**Shared — set on all 3 services** (or use a shared variable group):
```
NODE_ENV=production
RPC_URL=https://base-mainnet.g.alchemy.com/v2/<YOUR_KEY>   # private RPC (or https://base-rpc.publicnode.com)
AXIS_TOKEN_ADDRESS=0x65ECD6Df2eF1845B70A5c5c9c7E6Ed487d8e329D
VALIDATOR_REGISTRY_ADDRESS=0xcDbEb868D5955C04aD3A471388b5ebAeE65AcaE4
MARKETPLACE_ESCROW_ADDRESS=0xA9205dE579A21203CE5e29dAa1cCC6BC6434D699
DEPLOY_CHAIN_ID=8453
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_HOST=${{Redis.REDISHOST}}
REDIS_PORT=${{Redis.REDISPORT}}
REDIS_PASSWORD=${{Redis.REDISPASSWORD}}
ENGINE_INTERNAL_KEY=<long-random-secret>      # identical on all 3
```

**axis-engine only** (private + secret):
```
PORT=4000                                     # fixed internal port (it's private)
ENGINE_HOST=0.0.0.0
VALIDATOR_PRIVATE_KEY=<your funded mainnet key>   # secret — engine only
```

**axis-gateway + axis-marketplace** (reach the private engine + allow your site):
```
ENGINE_URL=http://${{axis-engine.RAILWAY_PRIVATE_DOMAIN}}:4000
CORS_ORIGIN=https://<your-site>.vercel.app
```

**axis-marketplace only:**
```
ESCROW_ONCHAIN=false      # flip to true later once an operator key is funded + liquidity is locked
# Required (and enforced at boot) when ESCROW_ONCHAIN=true:
MARKET_MINER_WALLET=0x...  # a server-owned operator EOA; the ONLY on-chain miner-fee payout target
MARKET_MAX_AMOUNT=100000   # max trade size per quote (bounds notional + any mint)
MARKET_MAX_FILL_AXIS=50    # per-fill cap on AXIS settled on-chain
```
> With `ESCROW_ONCHAIN=true` the marketplace **refuses to boot** in production if `MARKETPLACE_PRIVATE_KEY` is unset/a public test key, or if `MARKET_MINER_WALLET` is not a valid address. The on-chain miner-fee share is released **only** to `MARKET_MINER_WALLET` (never a client-supplied address) and is capped per fill — the market endpoints are public, so this stops anyone from routing minted AXIS to themselves.

Do **not** set `PORT` on the gateway/marketplace — let Railway assign it so their public domains route.

### Security variables (from the hardening pass) — where each goes
Generate the random secrets with:
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

| Variable | Value | Set on |
|---|---|---|
| `ENGINE_INTERNAL_KEY` | one random secret, **identical on all** | `axis-engine` + `axis-gateway` + `axis-marketplace` |
| `VALIDATOR_PRIVATE_KEY` | your private, funded validator key (never a Hardhat key) | `axis-engine` only |
| `BOT_SIGNER_SECRET` | one random secret, **set once and NEVER change** | `axis-telegram-bot` + `axis-whatsapp-agent` |
| `OPENAI_API_KEY` *or* `ANTHROPIC_API_KEY` | your own provider key (used only to grade results) | `axis-compute-market` only |

- The engine **warns** if `ENGINE_INTERNAL_KEY` is unset and **refuses to boot** if `VALIDATOR_PRIVATE_KEY` is a public test key — if a fresh engine deploy crash-loops, read its logs for this line.
- `ENGINE_INTERNAL_KEY` must match on engine + gateway + marketplace, or every engine forward returns 403 (mining silently breaks).
- Miners bring their OWN OpenAI/Anthropic key (browser widget / terminal / `axis-serve` worker) and that's how they earn — never put a miner key in any service.

> **Compute market** (`packages/compute-market`, the pay-AXIS-for-AI service) is a 4th service, deployed the same way: **+ New → GitHub Repo → axisai**, Root Directory `packages/compute-market`, generate a domain. It needs `TREASURY_PRIVATE_KEY`, an `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` (the grader), `RPC_URL`, `AXIS_TOKEN_ADDRESS`, and the shared `REDIS_*`. It does **not** need `ENGINE_INTERNAL_KEY` (it never calls the engine).

## 4. Deploy + verify
Each service builds, migrates, and starts. Check:
- `https://axis-gateway-*.up.railway.app/health` → `{"status":"ok",...,"engine":"ok"}`
- `https://axis-marketplace-*.up.railway.app/health` → ok
- engine has **no** public domain (correct).

## 5. Wire the website (Vercel)
Set on the Vercel project, then redeploy:
```
VITE_AXIS_GATEWAY_URL=https://axis-gateway-*.up.railway.app
VITE_AXIS_MARKET_URL=https://axis-marketplace-*.up.railway.app
```
Now anyone who opens the site mines real AXIS on Base mainnet. Terminal miners too:
`GATEWAY_URL=https://axis-gateway-*.up.railway.app pnpm mine` (or `pnpm mine:fleet --wallets 4`).

## 6. Keep it running
- **Fund the validator** `0x5681AA173AfBC4E646296EEF29C3b3D2DfC2a14b` with ETH on Base — it pays gas on every mint.
- Use a **private RPC** (Alchemy/Infura) for `RPC_URL` at real traffic; the public one rate-limits.
- Cost: ~the 3 small containers always-on + Postgres/Redis usage. To cut cost at scale, move Postgres→Neon and Redis→Upstash and point `DATABASE_URL`/`REDIS_*` at them.
