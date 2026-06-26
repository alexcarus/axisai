# AXIS AI — Telegram Bot

The primary mining interface for AXIS AI, built with **Telegraf**. Every command
is fully implemented (no stub handlers), uses **MarkdownV2** formatting, inline
keyboards for multi-option interactions, and per-command error handling.

## Commands

| Command | Description |
|---|---|
| `/start` | Welcome + live Genesis stats (epoch, reward, total mined, % complete) + progress bar + register prompt |
| `/register [wallet]` | Provisions your deterministic AXIS mining wallet, links it to your Telegram id, confirms with address + balance |
| `/mine` | Lists all 7 work types with estimated reward; inline buttons return a task payload + instructions |
| `/submit <work_type> <output_data>` | 60s rate limit, forwards to the gateway → engine, returns job id + estimates + status button |
| `/status <job_id>` | Full status: pending / verifying / approved (reward + tx hash) / rejected (reason) |
| `/balance` | Total AXIS earned, submissions, verification rate |
| `/epoch` | Current epoch, reward per unit, mined vs target, progress bar |
| `/leaderboard` | Top 10 miners this epoch, highlights your position if in top 20 |
| `/network` | Live difficulty D, active miners, total mined, % of supply |
| `/help` | Full command list |
| `/about` | Protocol overview, supply, Genesis explanation, how to start |

## Wallet model

Messaging interfaces are gateways, not custodians (whitepaper §8). Each Telegram
user is given a **deterministic mining wallet** derived from
`BOT_SIGNER_SECRET + "telegram" + user_id`. Because the derivation is
reproducible, the user can re-derive/export the exact same key off-platform — the
bot does not hold exclusive custody. All rewards accrue to this address, and the
bot signs submissions and gateway-auth challenges with it so requests pass the
gateway's signature checks.

## Setup

```bash
# from the repo root (workspaces install links @axis/shared)
npm install
cd packages/telegram-bot
cp .env.example .env     # set TELEGRAM_BOT_TOKEN, GATEWAY_URL, BOT_SIGNER_SECRET
npm start                # long-polling (local dev)
```

### BotFather setup

1. Open [@BotFather](https://t.me/BotFather) → `/newbot` → choose name + username.
2. Copy the token into `TELEGRAM_BOT_TOKEN`.
3. (Optional) `/setcommands` and paste:
   ```
   start - Welcome & Genesis stats
   register - Provision your mining wallet
   mine - Choose a work type
   submit - Submit work
   status - Check a submission
   balance - Your AXIS balance
   epoch - Epoch progress
   leaderboard - Top miners
   network - Network stats
   about - About AXIS
   help - Command list
   ```

### Production (webhook)

Set `TELEGRAM_WEBHOOK_DOMAIN` (public HTTPS domain) and `TELEGRAM_WEBHOOK_PORT`.
The bot will register the webhook automatically on launch.

### Docker

```bash
# from the repo root
docker build -f packages/telegram-bot/Dockerfile -t axis-telegram .
```
