#!/usr/bin/env node
"use strict";

/**
 * AXIS AI — auto marketing for Instagram.
 *
 * Pipeline:  generate (curated templates + live facts, NO AI API)
 *         →  grade    (deterministic quality benchmark — nothing junk ships)
 *         →  publish  (Instagram Graph API: a Reel or an image)
 *
 * Dry-run by default: it prints the caption and its quality score and posts
 * NOTHING. Pass --publish (with IG creds set) to actually post.
 *
 * Usage:
 *   node tools/marketing/index.js                 # dry-run, rotates theme
 *   node tools/marketing/index.js --theme browser # force a theme
 *   node tools/marketing/index.js --type image    # image instead of a Reel
 *   node tools/marketing/index.js --publish       # actually post (needs IG creds)
 *
 * Env:
 *   AXIS_MEDIA_BASE  base URL that serves the media (e.g. https://your-site)
 *                    — must be publicly reachable by Instagram's servers.
 *   AXIS_STATS_URL   public stats endpoint for live facts (optional)
 *   IG_USER_ID, IG_ACCESS_TOKEN, GRAPH_VERSION   Instagram credentials
 */

const { generatePost, THEMES } = require("./content");
const quality = require("./quality");
const ig = require("./instagram");
const state = require("./state");

function parseArgs(argv) {
  const args = { publish: false, type: "reel", json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--publish") args.publish = true;
    else if (a === "--json") args.json = true;
    else if (a === "--type") args.type = argv[++i];
    else if (a === "--theme") args.theme = argv[++i];
    else if (a === "--media-base") args.mediaBase = argv[++i];
    else if (a === "--stats-url") args.statsUrl = argv[++i];
    else if (a === "--min-score") args.minScore = Number.parseFloat(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

const HELP = `AXIS marketing — generate + grade + (optionally) publish an Instagram post.

  --publish            actually post (default: dry-run, posts nothing)
  --type reel|image    media type (default: reel — a 9:16 video)
  --theme <id>         force a theme (${THEMES.map((t) => t.id).join(", ")})
  --media-base <url>   base URL serving the media (or env AXIS_MEDIA_BASE)
  --stats-url <url>    public stats endpoint for live facts (or env AXIS_STATS_URL)
  --min-score <0..1>   quality threshold to pass (default 0.75)
  --json               machine-readable output
  -h, --help           this help
`;

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const mediaBase = (args.mediaBase || process.env.AXIS_MEDIA_BASE || "https://axis.ai").replace(/\/$/, "");
  const statsUrl =
    args.statsUrl ||
    process.env.AXIS_STATS_URL ||
    "https://compute-market-production.up.railway.app/health";
  const threshold = Number.isFinite(args.minScore) ? args.minScore : 0.75;

  const st = state.load();

  // Generate and grade. If the first pick fails the benchmark, try the next few
  // rotations/themes so a run still produces a publishable post when possible.
  let post = null;
  let grade = null;
  for (let attempt = 0; attempt < THEMES.length; attempt++) {
    const candidate = await generatePost({
      counter: (st.counter || 0) + attempt,
      themeId: attempt === 0 ? args.theme : undefined,
      statsUrl,
    });
    const g = quality.score(candidate.caption, threshold);
    if (g.pass) {
      post = candidate;
      grade = g;
      break;
    }
    if (!post) {
      post = candidate;
      grade = g;
    } // keep the best-effort candidate for reporting
  }

  const media =
    args.type === "image"
      ? { kind: "image", url: `${mediaBase}/axis-mint-reveal.jpg` }
      : { kind: "reel", url: `${mediaBase}/axis-mining.mp4`, cover: `${mediaBase}/axis-mining.jpg` };

  const report = {
    theme: post.themeId,
    type: media.kind,
    media_url: media.url,
    quality: grade.score,
    passed: grade.pass,
    reasons: grade.reasons,
    caption: post.caption,
  };

  if (!grade.pass) {
    if (args.json) process.stdout.write(`${JSON.stringify({ ...report, published: false }, null, 2)}\n`);
    else {
      process.stderr.write(
        `\n✗ Quality benchmark FAILED (score ${grade.score} < ${threshold}). Not publishing.\n` +
          `  reasons: ${grade.reasons.join("; ")}\n\n`,
      );
    }
    return 1;
  }

  if (!args.publish) {
    if (args.json) process.stdout.write(`${JSON.stringify({ ...report, published: false, dry_run: true }, null, 2)}\n`);
    else {
      process.stdout.write(
        `\n── AXIS post (DRY RUN — nothing posted) ──\n` +
          `theme:   ${post.themeId}\n` +
          `type:    ${media.kind}   media: ${media.url}\n` +
          `quality: ${grade.score}  ✓ passed\n\n${post.caption}\n\n` +
          `Run with --publish (and IG creds) to post for real.\n`,
      );
    }
    return 0;
  }

  // --- Publish ---
  if (!ig.isConfigured()) {
    process.stderr.write(
      "✗ --publish set but Instagram is not configured. Set IG_USER_ID and IG_ACCESS_TOKEN.\n",
    );
    return 2;
  }
  if (mediaBase.includes("axis.ai") && !process.env.AXIS_MEDIA_BASE && !args.mediaBase) {
    process.stderr.write(
      "✗ Set --media-base (or AXIS_MEDIA_BASE) to a URL that actually serves the media,\n" +
        "  e.g. your deployed site. Instagram must be able to fetch it.\n",
    );
    return 2;
  }

  let mediaId;
  try {
    mediaId =
      media.kind === "image"
        ? await ig.publishImage({ imageUrl: media.url, caption: post.caption })
        : await ig.publishReel({ videoUrl: media.url, coverUrl: media.cover, caption: post.caption });
  } catch (e) {
    process.stderr.write(`✗ Publish failed: ${e.message}\n`);
    return 3;
  }

  state.record(st, { theme: post.themeId, type: media.kind, media_id: mediaId });
  const out = { ...report, published: true, media_id: mediaId };
  if (args.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  else process.stdout.write(`\n✓ Published ${media.kind} to Instagram — media id ${mediaId}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err.message}\n`);
    process.exit(1);
  });
