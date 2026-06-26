# AXIS AI — WhatsApp Agent

Mirrors the Telegram bot's mining functionality through the **Meta WhatsApp
Business Cloud API**. Shares the same PostgreSQL `users`/`miners` tables and the
same deterministic mining-wallet model as the Telegram bot.

## Conversation flows (all implemented)

| Flow | Trigger | Behaviour |
|---|---|---|
| Onboarding | any first message | AXIS intro + live Genesis stats + wallet prompt |
| Register | sends `0x…` address | validates, provisions/links mining wallet, confirms |
| Mining | `mine` | interactive **list** of 7 work types with reward estimates |
| Task | selects a list row | task payload + instructions + "Submit sample" button |
| Submit | `submit <type> <output>` | 60s rate limit → gateway → engine, returns job id |
| Status | `status <job_id>` | full status, reward + tx hash if complete |
| Balance | `balance` | total AXIS earned, submissions, verification rate |
| Epoch | `epoch` | current epoch, reward/unit, Genesis progress bar |
| Network | `network` | live D, active miners, total mined, % supply |
| Leaderboard | `leaderboard` | top 10 this epoch |
| Help | `help` / unrecognised | full command list (graceful fallback) |

## Technical

* Stateful sessions per user in **Redis** (`src/session.js`).
* Meta **interactive list** + **reply buttons** (`src/whatsapp.js`).
* Webhook handler with **X-Hub-Signature-256** verification (`src/signature.js`).
* Rate limiting: 1 submit / user / 60s (Redis; also enforced cross-channel at the gateway).
* Graceful fallback to the help menu on any unexpected input.

## Meta Business API setup

1. Create an app at [developers.facebook.com](https://developers.facebook.com) → add the **WhatsApp** product.
2. Note your **App ID**, **App Secret**, **Phone Number ID**, and generate a (temporary or permanent) **Access Token**.
3. Set a **Verify Token** of your choice (`META_VERIFY_TOKEN`).
4. Configure the webhook:
   * Callback URL: `https://<your-domain>/webhook`
   * Verify token: the same `META_VERIFY_TOKEN`
   * Subscribe to the **messages** field.
5. Fill `.env` and start:

```bash
# from repo root (workspaces install links @axis/shared)
npm install
cd packages/whatsapp-agent
cp .env.example .env
npm start
```

Expose the webhook publicly (e.g. via a tunnel) for Meta to reach it during dev.

### Docker

```bash
# from the repo root
docker build -f packages/whatsapp-agent/Dockerfile -t axis-whatsapp .
```
