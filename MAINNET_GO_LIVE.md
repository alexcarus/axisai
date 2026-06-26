# AXIS AI — Base Mainnet Go-Live Runbook

End-to-end steps to take AXIS live on **Base mainnet (chainId 8453)** with mining,
minting, the market, and the web app integrated and ready for real users. Nothing
here changes AXIS's fundamentals (Proof-of-AI-Work + validators) — it's deploy +
wire + harden.

> **"Is the node live?"** On Base you do **not** run your own chain node. Base
> mainnet is itself the live, public node — you connect to it through an **RPC
> endpoint** (public `https://mainnet.base.org`, or a private one from Alchemy/
> Infura/QuickNode for reliability). "Going live" = deploying the AXIS contracts
> onto Base and pointing the off-chain services at that RPC.

---

## 0. Prerequisites

- A **funded, secret deployer key** on Base (NEVER the hardhat test keys in
  `.env`). Fund it with ~**0.003 ETH on Base** (covers deploy + first mints).
- A **validator key** the engine uses to mint (can be the same address as the
  deployer; it must be in the validator set). Keep it secret and funded — it
  pays gas on **every** mint.
- A **Base RPC URL** (public or private) and a **Basescan API key** (verification).
- Hosting for the off-chain stack: **Postgres**, **Redis**, **engine**,
  **gateway**, **marketplace** (any VPS/container host). The web is static.

---

## 1. Configure `.env` (the secret edits — you do these)

```ini
# Chain
RPC_URL=https://mainnet.base.org           # or your private Base RPC
BASE_RPC_URL=https://mainnet.base.org
CHAIN_ID=8453
DEPLOYER_PRIVATE_KEY=0x<FUNDED_SECRET_KEY>  # replaces the test key
VALIDATOR_PRIVATE_KEY=0x<FUNDED_SECRET_KEY> # engine minting key (a validator)
INITIAL_VALIDATORS=0x<validator1>[,0x<validator2>,...]  # governance-critical
BASESCAN_API_KEY=<key>

# Lock the engine down (already set for local; keep a strong unique value)
ENGINE_INTERNAL_KEY=<long-random-secret>
```

`.env` is gitignored — keep it off version control.

---

## 2. Deploy the contracts to Base

```bash
cd packages/contracts
npm run deploy:base          # -> deployments/base.json + base.env
# (dry run first, free: npm run deploy:base-sepolia)
```

Propagate the addresses into the root `.env` (token/registry/escrow + chainId)
from `deployments/base.json`, then verify on Basescan:

```bash
npx hardhat verify --network base <AXISToken> <ValidatorRegistry>
npx hardhat verify --network base <ValidatorRegistry> '[<validator1>,...]'
npx hardhat verify --network base <MarketplaceEscrow> <AXISToken> <ValidatorRegistry>
```

---

## 3. Database + services (hosted)

```bash
# point DATABASE_URL / REDIS_* at your hosted Postgres + Redis, then:
npm run migrate:all
npm run start:engine        # API + verification worker (keep ENGINE_INTERNAL_KEY set)
npm run start:gateway       # public entry point (auth, rate-limit, nonce, audit)
npm run start:marketplace   # AI market + on-chain escrow settlement
# optional channels:
TELEGRAM_BOT_TOKEN=... npm run start:telegram
```

Run engine + gateway + marketplace as managed services (systemd/Docker/PM2) with
restarts and logging. Only the **gateway** (and marketplace) should be public;
the **engine stays private** behind `ENGINE_INTERNAL_KEY` (verified: direct
access returns 403).

---

## 4. Point the web app at the live stack

In `mpp-main/.env`:

```ini
VITE_AXIS_GATEWAY_URL=https://gateway.yourdomain.com
VITE_AXIS_MARKET_URL=https://market.yourdomain.com
VITE_TELEGRAM_BOT=YourAxisBot     # optional
```

Build/deploy the site. The in-browser miner and market flip from SIMULATED to
**LIVE**: real signed submissions, real on-chain mints, real escrow settlement,
and the wallet panel shows each user's **on-chain AXIS balance (mined + bought)**.

Users get **one self-custodial wallet** (BIP-39 seed): they back up 12 words and
**log back in with the seed** to see their AXIS — same wallet across the web
miner, the market, the terminal (`--seed`), and Telegram (`/export`).

---

## 5. Make it ownerless (no contract changes)

```bash
cd packages/contracts
HH="../../node_modules/.bin/hardhat"
"$HH" run scripts/audit-ownership.js --network base     # the "no owners" receipt
DECENTRALIZE_ADD=0xIndependentValidator "$HH" run scripts/decentralize.js --network base
# once independents are in, renounce the deployer seat (they vote it through)
DECENTRALIZE_REMOVE=0xYourDeployer "$HH" run scripts/decentralize.js --network base
```

The token is already ownerless (no admin/multisig/pause, immutable, fixed 84M
supply). Solo for now = you're the sole bootstrap validator; decentralize when
others join.

---

## 6. Harden before real users

```bash
# against the LIVE gateway/engine/marketplace:
node tools/security/attack-suite.js          # gateway auth/replay/forgery/SQLi
node tools/security/mint-attack.js           # on-chain mint authorization + bounds
node tools/security/mine-quality-attack.js   # junk/tamper rejection
node tools/security/mine-demo.js             # positive end-to-end mint
```
All must report `secure`. **Before mainnet money, get the contracts audited** —
they're immutable; a bug can't be patched.

---

## 7. Costs to plan for

- **Deploy:** ~3.68M gas, one-time (cents–~$1 on Base).
- **Every mint:** the validator pays gas per approved block (fractions of a cent
  each on Base, but it scales with mining volume).
- **Market fills:** on-chain escrow release pays gas per settled fill.
- **Hosting:** Postgres + Redis + 3 Node services + RPC (a private RPC is
  recommended at volume).

---

## Go-live checklist

- [ ] Funded, secret deployer + validator keys (no test keys anywhere)
- [ ] Contracts deployed to Base + verified on Basescan
- [ ] `audit-ownership.js` → `VERDICT: OWNERLESS ✓`
- [ ] Postgres/Redis hosted, `migrate:all` run
- [ ] engine (private) + gateway + marketplace running with restarts
- [ ] `ENGINE_INTERNAL_KEY` strong + engine not publicly reachable
- [ ] Web pointed at live gateway/market, miner+market show LIVE
- [ ] All security suites pass against the live stack
- [ ] Contract audit complete
- [ ] Validator wallet funded with ETH for ongoing mint gas
