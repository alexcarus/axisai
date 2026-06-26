# AXIS AI — Security & smoke tooling

Reusable scripts that exercise the **running** stack. Bring it up first
(`./start.sh`) and run `npm install` once at the repo root (links `@axis/shared`
and `ethers`).

| Script | Purpose |
|---|---|
| `mine-demo.js` | End-to-end mining smoke test through the gateway → engine → on-chain mint. |
| `attack-suite.js` | Adversarial regression suite (see [`../../SECURITY.md`](../../SECURITY.md)). Exits non-zero if any check is `[VULN]`. |

Both read endpoint URLs from env (`GATEWAY_URL`, `ENGINE_URL`, `MARKETPLACE_URL`,
`RPC_URL`) and `BOT_SIGNER_SECRET`, with localhost defaults.

```bash
node tools/security/mine-demo.js
node tools/security/attack-suite.js
```

> Note: the attack suite intentionally generates gateway violations; the gateway
> will IP-ban the source after `BAN_VIOLATION_THRESHOLD` (default 5) within the
> ban window. If a re-run shows `403`s on the gateway checks, that is the ban
> working — clear it with:
> `redis-cli --scan --pattern 'gw:*' | xargs redis-cli del`
