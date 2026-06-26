# AXIS AI — API Gateway

A standalone **Fastify** service that sits between every user-facing interface
(Telegram, WhatsApp, Direct API) and the verification engine. **Nothing reaches
the engine without passing through this gateway.**

## Responsibilities

### Authentication
* Every request must include a `wallet_address` and a **signed message**.
* `POST /gateway/submit` — the body's submission signature is verified
  (same canonical message the engine verifies).
* Read endpoints — a signed challenge is required via headers:
  * `x-wallet-address`, `x-timestamp`, `x-signature`
  * message: `AXIS-GATEWAY-AUTH|<wallet lowercased>|<timestamp ms>` (max age 300s).
* Unsigned / incorrectly signed requests are rejected immediately.

### Cross-channel rate limiting
* Wallet cooldown is keyed by **wallet only** in Redis, so a wallet that submits
  via Telegram cannot also submit via WhatsApp within the same 60s window.

### Nonce enforcement
* Each submission includes `nonce`, `timestamp`, `block_height`.
* `nonce == keccak256(wallet|timestamp|block_height)` is recomputed server-side.
* The nonce is consumed via Redis `SET NX`; a duplicate nonce is rejected and
  the wallet is **flagged for review**.

### DDoS protection
* IP rate limiting: **100 requests / IP / minute**.
* Wallet rate limiting: **1 submission / 60 seconds**.
* Repeated violations (default 5 within the ban window) trigger an automatic
  temporary ban (default 15 minutes), applied to both IPs and wallets.

### Request logging (audit trail)
* Every request is logged to PostgreSQL (`gateway_audit_log`) with channel,
  wallet, work_type, timestamp, ip_address, route and result.

### Anomaly detection
* If one wallet submits from **3+ distinct IPs within 1 hour**, it is flagged in
  `gateway_review_flags`.

## Endpoints

| Gateway route | Proxied to engine |
|---|---|
| `POST /gateway/submit` | `POST /submit` |
| `GET /gateway/status/:jobId` | `GET /status/:jobId` |
| `GET /gateway/miner/:wallet` | `GET /miner/:wallet` |
| `GET /gateway/network/stats` | `GET /network/stats` |
| `GET /gateway/leaderboard` | `GET /network/leaderboard` |
| `GET /health` | gateway + engine connectivity |

## Submission body shape

```json
{
  "wallet_address": "0x...",
  "work_type": "inference_text",
  "input_hash": "0x...",
  "output_hash": "0x...",
  "output_data": "{...}",
  "timestamp": 1717000000000,
  "block_height": 12345,
  "nonce": "0x...",            // keccak256(wallet|timestamp|block_height)
  "signature": "0x...",        // signs AXIS-POAIW-SUBMISSION|...
  "channel": "telegram"
}
```

## Setup

```bash
cd packages/gateway
cp .env.example .env
npm install
npm run migrate
npm start
```

### Docker

```bash
docker-compose up --build
```
