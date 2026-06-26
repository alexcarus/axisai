# AXIS AI — Proof-of-AI-Work Verification Engine

Off-chain engine that receives miner work submissions, verifies them, scores
them, computes rewards, and submits cryptographic proofs to the AXIS smart
contracts (which mint the reward).

## Pipeline (whitepaper section 5)

Every submission runs the full ten-step pipeline (`src/pipeline/verify.js`):

1. **Receive** `{ wallet_address, work_type, input_hash, output_hash, output_data, timestamp, signature }`.
2. **Verify signature** — recovers the signer from the canonical message and checks it equals `wallet_address`.
3. **Validate output commitment** — `keccak256(output_data) === output_hash`.
4. **Score** — work-type-specific scoring → `Q ∈ [0,1]`.
5. **Peer validation** — randomly samples 3 prior submissions of the same type and cross-checks for consistency (sharp outliers are flagged as fraud).
6. **Compute W** — verified workload units from work type + data size.
7. **Fetch D** — reads the current difficulty from the token contract.
8. **Compute reward** — `W × Q ÷ D`, previewed on-chain via `previewReward`.
9. **Submit proof** — `ValidatorRegistry.submitWork(wallet, W, Q)` mints the reward.
10. **Reject path** — on fraud / low score: reject, log the reason, apply a 60-second wallet cooldown.

## Scoring functions (`src/scoring/`, all real implementations)

| Work type | Method |
|---|---|
| `inference_text` | Hashing-trick embedding + **cosine similarity** vs reference embeddings |
| `inference_image` | **SSIM** on grayscale pixel arrays (CLIP-style caption-cosine fallback) |
| `inference_audio` | Spectral/MFCC **cosine correlation** vs reference |
| `training_step` | **Loss-delta** validation within per-architecture bounds |
| `dataset_labeling` | **Agreement rate** vs per-batch majority peer labels |
| `synthetic_data_generation` | **KL divergence** vs reference distribution → `exp(-KL)` |
| `peer_validation` | **Consensus-consistency** vs majority peer rating |

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/submit` | Accept a submission, queue it for verification |
| `GET` | `/status/:jobId` | Job status, score, reward, tx hash |
| `GET` | `/miner/:wallet` | Profile: submitted / verified / AXIS earned / cooldown |
| `GET` | `/network/stats` | Current D, epoch, total mined, % supply, active miners 24h |
| `GET` | `/network/leaderboard` | Top 20 miners by AXIS earned this epoch |
| `GET` | `/health` | Liveness + Postgres/Redis connectivity |

## Architecture

* **Express.js** REST API (`src/server.js`)
* **Bull** queue + worker for async verification (`src/queue`, `src/worker.js`)
* **Redis** for job state, cooldowns and the peer-sample cache
* **PostgreSQL** for submissions, miner records and scores (`src/db`)
* **Ethers.js** for contract reads + proof submission (`src/chain/contract.js`)
* **Winston** logging on every pipeline step

## Setup

```bash
cd packages/engine
cp .env.example .env     # fill in AXIS_TOKEN_ADDRESS, VALIDATOR_REGISTRY_ADDRESS, VALIDATOR_PRIVATE_KEY
npm install
npm run migrate          # create tables
npm start                # API + worker in one process
# or, scaled:
npm run api              # API only
npm run worker           # worker only
```

> The `VALIDATOR_PRIVATE_KEY` must belong to an address that is a member of the
> on-chain `ValidatorRegistry`, otherwise `submitWork` reverts.

### With Docker

```bash
docker-compose up --build
```

## Testing a submission

Generate a correctly-signed submission and post it:

```bash
# Build a signed body (use a funded local validator key for end-to-end mint)
node tools/sign-submission.js 0xYOUR_PRIVATE_KEY inference_text \
  '{"text":"the inference output is coherent relevant and accurate"}' > sub.json

curl -X POST http://localhost:4000/submit -H 'Content-Type: application/json' -d @sub.json
# -> { "job_id": "...", "status": "pending", ... }

curl http://localhost:4000/status/<job_id>
```
