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
```

Do **not** set `PORT` on the gateway/marketplace — let Railway assign it so their public domains route.

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
