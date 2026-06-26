# AXIS AI — Smart Contracts

This package contains the on-chain core of the AXIS AI Proof-of-AI-Work (PoAIW)
protocol:

| Contract | Purpose |
|---|---|
| `AXISToken.sol` | Fixed-supply ERC-20. Mintable only by the ValidatorRegistry. Enforces the reward formula, Genesis epoch schedule, and the 84,000,000 AXIS hard cap. |
| `ValidatorRegistry.sol` | Holds the approved validator set. Only validators may submit verified work proofs. The validator set and the difficulty factor `D` change only by **> 66% supermajority vote**. |
| `MarketplaceEscrow.sol` | Escrows AXIS for marketplace compute jobs and TX-capacity trades; settlement is authorised by validators. |

There is **no owner, no admin, no multisig, no upgrade proxy, and no pause
function**. After deployment, issuance follows the deterministic rules forever.

---

## Reward model

The whitepaper defines `AXIS Reward = W × Q ÷ D` (section 5.3) and a Genesis
emission schedule of 200 / 100 / 50 / 25 AXIS per verified work unit
(section 4.3). These are reconciled on-chain as:

```
reward = baseEpochReward × (W × Q) / (D × 100)
```

* `baseEpochReward` — the per-work-unit emission for the epoch implied by
  `totalMinted` (200 → 100 → 50 → 25 during Genesis; then a geometric-halving
  continuation of 12.5 → 6.25 → 3.125 across the Standard / Late / Terminal
  phases whose sizes come from whitepaper section 6).
* `W` — verified workload units (`uint256`).
* `Q` — quality score passed as an integer `0..100` (representing `0.0..1.0`).
* `D` — on-chain difficulty factor, initialised to `1` (lowest permitted),
  changeable only by validator supermajority.

A single standard work unit at perfect quality and minimum difficulty
(`W=1, Q=100, D=1`) mints exactly the epoch reward — e.g. **200 AXIS** in
Genesis Epoch 1 — matching the whitepaper table exactly.

### Epoch / phase thresholds

| Epoch (`currentEpoch()`) | Cumulative end | Base reward |
|---|---|---|
| 1 (Genesis) | 5,250,000 | 200 AXIS |
| 2 (Genesis) | 10,500,000 | 100 AXIS |
| 3 (Genesis) | 15,750,000 | 50 AXIS |
| 4 (Genesis) | 21,000,000 | 25 AXIS |
| 5 (Standard) | 63,000,000 | 12.5 AXIS |
| 6 (Late) | 79,800,000 | 6.25 AXIS |
| 7 (Terminal) | 84,000,000 | 3.125 AXIS |
| 0 (Exhausted) | — | 0 (minting permanently disabled) |

Epoch transitions are automatic — driven purely by `totalMinted`, with no
manual trigger.

---

## Constructor arguments

* **ValidatorRegistry(`address[] initialValidators`)** — the genesis validator
  set (non-empty, no zero/duplicate addresses).
* **AXISToken(`address validatorRegistry`)** — the registry address, which
  becomes the immutable sole minter.
* **MarketplaceEscrow(`address axis`, `address registry`)** — the token and
  registry addresses.

---

## Setup

```bash
cd packages/contracts
cp .env.example .env       # fill in RPC_URL, DEPLOYER_PRIVATE_KEY, etc.
npm install
npm run compile
npm test
```

## Local deployment

```bash
# Terminal 1 — start a local chain
npm run node

# Terminal 2 — deploy
npm run deploy:local
```

Deployment writes:

* `deployments/<network>.json` — full address manifest.
* `deployments/<network>.env` — `AXIS_TOKEN_ADDRESS`, `VALIDATOR_REGISTRY_ADDRESS`,
  `MARKETPLACE_ESCROW_ADDRESS`, `DEPLOY_CHAIN_ID` for the other services.

## Public network deployment

1. Set `RPC_URL`, `CHAIN_ID`, `DEPLOYER_PRIVATE_KEY`, `INITIAL_VALIDATORS`,
   and `ETHERSCAN_API_KEY` in `.env`.
2. Deploy:
   ```bash
   HARDHAT_NETWORK=custom npm run deploy
   ```

## Verification

```bash
# ValidatorRegistry (array arg must be passed via a JS module on real networks)
npx hardhat verify --network custom <REGISTRY_ADDRESS> '["0xValidator1","0xValidator2"]'

# AXISToken
npx hardhat verify --network custom <TOKEN_ADDRESS> <REGISTRY_ADDRESS>

# MarketplaceEscrow
npx hardhat verify --network custom <ESCROW_ADDRESS> <TOKEN_ADDRESS> <REGISTRY_ADDRESS>
```

## Deployment order (enforced by `scripts/deploy.js`)

1. `ValidatorRegistry(initialValidators)`
2. `AXISToken(registry)` — registry is the permanent minter
3. `registry.initializeToken(token)` — one-time, permanent binding
4. `MarketplaceEscrow(token, registry)`

## Tests

`test/axis.test.js` covers:

* token metadata & invariants;
* unauthorized mint rejection (EOA + non-validator);
* the reward formula (W, Q, D scaling) and `previewReward`;
* automatic epoch transitions across all four Genesis epochs and into Standard;
* the 84,000,000 AXIS hard cap, final-mint clamping and supply exhaustion;
* validator supermajority voting (add/remove/difficulty), double-vote and
  non-validator rejection, and last-validator protection.
