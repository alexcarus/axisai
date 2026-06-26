#!/usr/bin/env bash
# ===========================================================================
# AXIS AI — one-shot local bring-up.
#
#   1. Verifies required env vars are set (creating .env from .env.example).
#   2. Brings up shared infra (PostgreSQL, Redis, Hardhat node).
#   3. Deploys the contracts and writes the addresses back into ./.env.
#   4. Runs all database migrations.
#   5. Starts every service in the correct order.
#
# Usage:
#   ./start.sh            # full local stack via docker for infra + node services
#   ./start.sh --native   # run the Node services natively (infra still docker)
# ===========================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

NATIVE=false
[[ "${1:-}" == "--native" ]] && NATIVE=true

log()  { printf "\033[1;36m[axis]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[axis]\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m[axis]\033[0m %s\n" "$*" >&2; }

# Pick the available docker compose command.
if command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
elif docker compose version >/dev/null 2>&1; then
  DC="docker compose"
else
  err "docker-compose / 'docker compose' is required."; exit 1
fi

# --- 1. Env -------------------------------------------------------------- #
if [[ ! -f .env ]]; then
  log "Creating .env from .env.example"
  cp .env.example .env
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

REQUIRED_VARS=(POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB DATABASE_URL RPC_URL DEPLOYER_PRIVATE_KEY)
MISSING=0
for v in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!v:-}" ]]; then err "Required env var $v is not set"; MISSING=1; fi
done
[[ $MISSING -eq 1 ]] && { err "Fix the missing env vars in .env and re-run."; exit 1; }
log "Environment OK"

# Helper: upsert KEY=VALUE into .env
set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env; then
    # Use a temp file for portable in-place edit.
    grep -vE "^${key}=" .env > .env.tmp && mv .env.tmp .env
  fi
  printf "%s=%s\n" "$key" "$value" >> .env
}

# --- 2. Infra ------------------------------------------------------------ #
log "Starting infrastructure (postgres, redis, hardhat)…"
$DC up -d postgres redis hardhat

log "Waiting for Hardhat RPC at ${RPC_URL}…"
for i in $(seq 1 60); do
  if curl -s -X POST -H 'Content-Type: application/json' \
       --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' \
       "${RPC_URL}" | grep -q result; then
    log "Hardhat node is up."; break
  fi
  sleep 1
  [[ $i -eq 60 ]] && { err "Hardhat node did not become ready."; exit 1; }
done

# --- 3. Deploy contracts ------------------------------------------------- #
if [[ ! -d node_modules ]]; then
  log "Installing workspace dependencies (npm install)…"
  npm install
fi

log "Deploying contracts to localhost…"
RPC_URL="$RPC_URL" DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" INITIAL_VALIDATORS="${INITIAL_VALIDATORS:-}" \
  npm --workspace @axis/contracts run deploy:local

DEPLOY_ENV="packages/contracts/deployments/localhost.env"
[[ -f "$DEPLOY_ENV" ]] || { err "Deployment env fragment not found at $DEPLOY_ENV"; exit 1; }

log "Writing contract addresses into ./.env"
# shellcheck disable=SC1090
source "$DEPLOY_ENV"
set_env AXIS_TOKEN_ADDRESS "$AXIS_TOKEN_ADDRESS"
set_env VALIDATOR_REGISTRY_ADDRESS "$VALIDATOR_REGISTRY_ADDRESS"
set_env MARKETPLACE_ESCROW_ADDRESS "$MARKETPLACE_ESCROW_ADDRESS"
set_env DEPLOY_CHAIN_ID "$DEPLOY_CHAIN_ID"
log "Addresses: token=$AXIS_TOKEN_ADDRESS registry=$VALIDATOR_REGISTRY_ADDRESS escrow=$MARKETPLACE_ESCROW_ADDRESS"

# Reload with new addresses.
set -a; source .env; set +a

# --- 4. Migrations ------------------------------------------------------- #
log "Running database migrations…"
npm run migrate:all

# --- 5. Start services --------------------------------------------------- #
if [[ "$NATIVE" == true ]]; then
  log "Starting Node services natively (logs in ./logs)…"
  mkdir -p logs
  nohup npm run start:engine      > logs/engine.log      2>&1 &
  sleep 2
  nohup npm run start:gateway     > logs/gateway.log     2>&1 &
  nohup npm run start:marketplace > logs/marketplace.log 2>&1 &
  [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] && nohup npm run start:telegram > logs/telegram.log 2>&1 || warn "TELEGRAM_BOT_TOKEN unset — skipping Telegram bot"
  [[ -n "${META_ACCESS_TOKEN:-}" ]] && nohup npm run start:whatsapp > logs/whatsapp.log 2>&1 || warn "META_ACCESS_TOKEN unset — skipping WhatsApp agent"
  log "Native services launched. Tail logs in ./logs/*.log"
else
  log "Starting application services via docker-compose…"
  $DC up -d --build engine gateway marketplace
  [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] && $DC up -d --build telegram-bot || warn "TELEGRAM_BOT_TOKEN unset — skipping Telegram bot"
  [[ -n "${META_ACCESS_TOKEN:-}" ]] && $DC up -d --build whatsapp-agent || warn "META_ACCESS_TOKEN unset — skipping WhatsApp agent"
fi

log "AXIS AI stack is up:"
log "  Engine       http://localhost:${ENGINE_PORT:-4000}/health"
log "  Gateway      http://localhost:${GATEWAY_PORT:-3000}/health"
log "  Marketplace  http://localhost:${MARKETPLACE_PORT:-5000}/docs"
log "Done."
