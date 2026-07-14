# AXIS Liquidity Runbook — ETH/AXIS · Uniswap v4 · Base

Goal: make AXIS **buyable/sellable with real money** AND let the compute-market
**auto-sell self-fund the validator** — both trade against the *same* pool. Put
real, full-range depth into that pool and both problems are solved. No contract
changes.

> ⚠️ CORRECTED: an earlier version of this doc pointed at an **AXIS/USDC** pool.
> That is NOT the pool your code uses. Your site's swap widget (`uniswap-v4.ts`)
> and the compute-market auto-sell (`costcoverage.js`) both trade the **ETH/AXIS**
> pool below (poolId `0x4425a476…`). Add liquidity **here**, pairing **ETH**.

---

## 0. The exact pool (do not substitute — verified in your live code)

| Field | Value |
|---|---|
| Network | **Base** (chainId 8453) |
| DEX | **Uniswap v4** |
| currency0 | **ETH** (native, `0x0000…0000`, 18 dp) |
| currency1 | **AXIS** `0x6DBBd1910BeFC6736b818d4DcaD3ff833b9e06D7` (18 dp) |
| Fee tier | **1%** (`10000`) |
| Tick spacing | **200** |
| Hooks | none (`0x0`) |
| poolId | `0x4425a476a588b210c430062cfa30a7adc26fae4dbb1ddb2b8db488bbde16255a` |

### Live state (checked)
- **Price ≈ $0.0038 / AXIS** (≈ FDV $321k × 84,000,000). ETH ≈ $1,869.
- **Depth: thin** — a normal trade moves the price a lot, and the auto-sell's 3%
  price-impact guard refuses to sell into it. This is the whole blocker.

---

## 1. Decisions (yours, before funding)

**a) Launch price.** The pool sits at ~$0.0038. Keep it (add around that price —
simplest, safest, no arbitrage risk) or reprice higher (advanced — ask first).

**b) Range → use FULL RANGE.** v4 is concentrated liquidity: your money only works
while the price is *inside* your range. Full Range = min↔max = always active,
never "out of range," zero management, behaves like a simple constant-product
market. This is what you want. (Your $50 was likely a narrow/wrong range → parked
and inactive.)

**c) How much (this IS the depth).** Pair roughly equal USD value of ETH + AXIS:

| Total depth | ≈ ETH side | ≈ AXIS to pair | A buy that moves price ~10% |
|---|---|---|---|
| $1,000 | ~0.27 ETH | ~131,000 AXIS | ~$100 |
| $5,000 | ~1.34 ETH | ~657,000 AXIS | ~$500 |
| $10,000 | ~2.7 ETH | ~1,315,000 AXIS | ~$1,000 |

**$50 is far too thin** for real trading, listings (CoinGecko/CMC), or the
auto-sell. Aim for at least a few thousand. (AXIS is cheap, so each $1 of ETH
depth pairs with a lot of AXIS — that's the argument for a higher launch price;
ask if you want to reprice.)

---

## 2. Prerequisites (one wallet, on Base)
- The **ETH** you'll deposit + a little extra ETH for gas.
- The **AXIS** to pair — consolidate from your miner wallet(s) into this wallet.
- Confirm you're on **Base**, not Ethereum mainnet.

---

## 3. Add it — Uniswap web app (safest)
1. **app.uniswap.org** → connect → switch to **Base**.
2. **Positions → + New position** → confirm **v4**.
3. **Token A = ETH** (native). **Token B = AXIS** — paste `0x6DBBd1910BeFC6736b818d4DcaD3ff833b9e06D7`, confirm the address matches exactly.
4. **Fee tier: 1%** → this resolves the **existing** pool; you should see price ~**$0.0038/AXIS**. 🚨 If it offers to *create* a pool or shows a wildly different price, **stop** — the pair/fee is wrong and you'd make a second, useless pool.
5. **Range: Full Range.**
6. **Amounts:** type the ETH amount; the app auto-fills the AXIS at the current price.
7. **Approve** (Permit2 + approve AXIS) → **Add** → confirm.

**"No transaction" last time?** An add needs: gas ETH on Base, an approve tx, and
the add/mint tx you confirm — on the *existing* pool. Miss any and nothing lands.

---

## 4. Why this fixes the validator auto-funding
The compute-market auto-sell (`sellAxisForEth`) swaps AXIS→ETH on **this exact
pool**. Once it's full-range + deep:
1. A ~50-AXIS sale (~$0.19) has tiny price impact → clears the 3% guard (today the
   thin pool = ~infinite impact → blocked).
2. Swap executes → treasury gets ETH → forwards a top-up to the validator
   `0x2D4c3f98be9B0FC02D7027e1ccc8Cec4a6449BeC` when it dips below 0.003 ETH.

So: **deep full-range pool → auto-sell works → validator refills itself → you stop
hand-funding it** (given some compute-market volume producing the AXIS fees).

---

## 5. Next: make the pool self-deepen (protocol-owned liquidity)
Seeding above is a one-time capital step. To keep depth *growing from real usage
without more of your capital*, route a slice of compute-market fees into
**buying AXIS + adding full-range liquidity** (POL). That leg does not exist yet
(the buyback slice currently burns) — it's a build. Ask and I'll wire it into the
revenue split (OFF + dry-run by default, like the existing split).

---

## 6. Verify
- basescan: the mint tx succeeded.
- Site `/market`: real quotes, small price impact on a normal trade.
- Do a tiny **$5 buy + sell** end-to-end. If both fill at sane prices, real-money
  buy/sell is live.

**Stopgap until funded:** send ~0.02 ETH to `0x2D4c3f98be9B0FC02D7027e1ccc8Cec4a6449BeC` on Base so mints don't stall.
