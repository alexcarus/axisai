# AXIS AI — auto marketing (Instagram)

Generates on-brand AXIS posts, **grades every one with a deterministic quality
benchmark**, and publishes to Instagram as a Reel or image. It uses **no AI/LLM
API** — captions come from curated templates plus a few live protocol facts, so
posting is free and always on-message. The only network API is Instagram's own
Content Publishing API (to actually post) and an optional public stats endpoint.

```
generate (templates + live facts)  →  grade (quality benchmark)  →  publish (Graph API)
        no API cost                        no API cost                platform API
```

## Quick start

```bash
# 1. Dry run — prints the caption + quality score, posts NOTHING:
node tools/marketing/index.js

# 2. Force a theme or an image instead of a Reel:
node tools/marketing/index.js --theme browser
node tools/marketing/index.js --type image

# 3. Publish for real (needs Instagram creds + a public media URL):
AXIS_MEDIA_BASE=https://your-deployed-site \
IG_USER_ID=1784xxxxxxxxxxx \
IG_ACCESS_TOKEN=EAAG... \
node tools/marketing/index.js --publish
```

## The quality benchmark (why posts aren't junk)

`quality.js` scores each caption 0–1 and **hard-fails** broken output before it
can post. It's the same idea as the protocol's key-free PoAIW scoring: a
re-runnable, auditable, model-free check — no LLM judge, no API, no randomness.

- **Hard fails (block posting):** leftover template tokens (`{`, `undefined`,
  `NaN`…), too short/long for Instagram, wrong number of hashtags.
- **Scored signals (need ≥ 0.75):** a real hook, a clear call-to-action,
  well-formed hashtags in range, on-brand (mentions AXIS), some structure, no
  spammy word repetition, and enough real words to read.

If the first rotation fails the gate, it tries the next themes before giving up,
and exits non-zero if nothing passes — so a scheduler never posts garbage.

Tune strictness with `--min-score 0.85`. Extend `score()` with a learned signal
later (e.g. engagement) without changing the `{ pass, score, reasons }` contract.

## Instagram setup (one time)

1. Convert the Instagram account to a **Business** or **Creator** account and
   link it to a Facebook Page.
2. Create a Meta app, add **Instagram Graph API**, and get a **long-lived**
   access token with `instagram_content_publish` (and `instagram_basic`).
3. Find your **IG Business account id** (`IG_USER_ID`).
4. Host the media somewhere Instagram can fetch it — the deployed site already
   serves `/axis-mining.mp4` (a 9:16 Reel) and `/axis-mint-reveal.jpg`. Point
   `AXIS_MEDIA_BASE` at that site.

| Env var | What it is |
|---|---|
| `IG_USER_ID` | Instagram Business account id (numeric) |
| `IG_ACCESS_TOKEN` | long-lived token with `instagram_content_publish` |
| `GRAPH_VERSION` | optional, defaults to `v21.0` |
| `AXIS_MEDIA_BASE` | public base URL serving the media (your site) |
| `AXIS_STATS_URL` | optional public stats endpoint for live facts |

## Run it on a schedule

Post once a day (dry-run first to confirm, then add `--publish`):

```bash
# crontab -e  — every day at 15:00
0 15 * * * cd /path/to/Axisailp && AXIS_MEDIA_BASE=https://your-site IG_USER_ID=… IG_ACCESS_TOKEN=… node tools/marketing/index.js --publish >> /var/log/axis-market.log 2>&1
```

It rotates themes/variants across runs (state in `.axis-marketing-state.json`,
gitignored) so posts stay varied.

## Files

- `content.js` — curated themes + hashtag pools + best-effort live facts.
- `quality.js` — the deterministic quality benchmark (the anti-junk gate).
- `instagram.js` — Instagram Graph API client (Reel + image).
- `state.js` — rotation counter + post history.
- `index.js` — the CLI pipeline (dry-run by default).
