# AXIS AI — Compute Marketplace

The AXIS AI compute marketplace backend (whitepaper sections 7 & 9): model
registry, compute job system, TX capacity exchange, supply/demand pricing
engine, escrow, and reputation. **Node.js + Express**, PostgreSQL, Redis, Bull,
Ethers.js, and auto-generated Swagger docs at `/docs`.

## Endpoints

### Model registry
| Method | Path | Notes |
|---|---|---|
| POST | `/models/publish` | name, description, I/O schema, price, owner, signed ownership |
| GET | `/models` | paginated; filters `work_type`, `min_rating`, `max_price`; sorted by provider reputation |
| GET | `/models/:id` | detail + usage stats + rating history |
| POST | `/models/:id/rate` | 1–5 stars, one rating per wallet (signed) |
| DELETE | `/models/:id` | owner-only via signed message |

### Compute jobs
| Method | Path | Notes |
|---|---|---|
| POST | `/jobs/request` | locks escrow; async provider matching (lowest price, highest rating) |
| POST | `/jobs/:id/deliver` | provider output → PoAIW engine scoring → escrow settlement |
| GET | `/jobs/:id` | status, provider, input/output hash, verification, settlement tx |
| GET | `/jobs/requester/:wallet` | all jobs by requester |
| GET | `/jobs/provider/:wallet` | all jobs fulfilled by provider |

### TX capacity exchange
| Method | Path | Notes |
|---|---|---|
| POST | `/capacity/offer` | list capacity (units, price/tx, expiry, signed) |
| GET | `/capacity` | available offers sorted by price |
| POST | `/capacity/purchase` | purchase units; AXIS settled at purchase |

### Pricing engine
* Every 60s snapshots demand (open jobs) and capacity (available offers) and
  computes `price = base_price × demand / max(capacity, 1)` (whitepaper 7.3),
  stored in the `price_snapshots` time-series.

| Method | Path |
|---|---|
| GET | `/price/current` |
| GET | `/price/history?hours=24` |

### Reputation
* `provider_score` = weighted average of job completion rate, verification pass
  rate, and delivery-time factor.
* `requester_score` = payment reliability and (1 − dispute rate).

| Method | Path |
|---|---|
| GET | `/reputation/:wallet` |

## Escrow lifecycle

* **Job creation** → escrow locked (`escrows` row + `locked` event).
* **Verified delivery** → escrow released to provider (engine score ≥ `JOB_MIN_QUALITY`).
* **Timeout** (default 30 min, Bull-scheduled) → refund to requester.
* **Fraud** (quality < 0.2) → refund to requester + provider flagged.

PostgreSQL is the authoritative record; set `ESCROW_ONCHAIN=true` with a
validator-authorised `MARKETPLACE_PRIVATE_KEY` to mirror release/refund/flag
on-chain via `MarketplaceEscrow.sol`.

## Signed messages

Every mutating endpoint reconstructs a canonical message and verifies the
signature recovers to the claimed wallet, e.g.:

```
publish:           AXIS-MKT|publish|<owner>|<name>|<price>
rate:              AXIS-MKT|rate|<wallet>|<modelId>|<stars>
job-request:       AXIS-MKT|job-request|<requester>|<modelId>|<maxPrice>
job-deliver:       AXIS-MKT|job-deliver|<provider>|<jobId>
capacity-offer:    AXIS-MKT|capacity-offer|<provider>|<units>|<price>|<expiry>
capacity-purchase: AXIS-MKT|capacity-purchase|<buyer>|<offerId>|<units>
```

## Setup

```bash
cd packages/marketplace
cp .env.example .env
npm install
npm run migrate
npm start          # API + pricing engine + workers; docs at http://localhost:5000/docs
```

### Docker

```bash
docker-compose up --build
```
