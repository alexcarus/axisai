"use strict";

/**
 * AXIS AI — Instagram publisher (Instagram Graph API, Content Publishing).
 *
 * This is a platform API for posting — NOT an AI/LLM API. Captions are generated
 * and graded locally (content.js + quality.js); this module only uploads a Reel
 * or image to an Instagram *Business/Creator* account and publishes it.
 *
 * Requirements (set as env vars):
 *   IG_USER_ID       — the Instagram Business account id (numeric)
 *   IG_ACCESS_TOKEN  — a long-lived access token with instagram_content_publish
 *   GRAPH_VERSION    — optional, defaults to v21.0
 *
 * Media must be a PUBLIC https URL that Instagram's servers can fetch — point it
 * at the deployed site's assets (e.g. https://<site>/axis-mining.mp4). Reels use
 * a vertical (9:16) video; the site's /axis-mining.mp4 is exactly that.
 */

const GRAPH = "https://graph.facebook.com";

function cfg() {
  const version = process.env.GRAPH_VERSION || "v21.0";
  const userId = process.env.IG_USER_ID || "";
  const token = process.env.IG_ACCESS_TOKEN || "";
  return { version, userId, token, base: `${GRAPH}/${version}` };
}

/** True when the Instagram credentials are present. */
function isConfigured() {
  const c = cfg();
  return Boolean(c.userId && c.token);
}

async function graph(method, path, params) {
  const c = cfg();
  const url = new URL(`${c.base}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: c.token });
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = { raw: text };
  }
  if (!res.ok || json.error) {
    const msg = json.error?.message || `HTTP ${res.status}`;
    throw new Error(`Instagram API: ${msg}`);
  }
  return json;
}

async function graphGet(path, params = {}) {
  const c = cfg();
  const url = new URL(`${c.base}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", c.token);
  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok || json.error) {
    throw new Error(`Instagram API: ${json.error?.message || res.status}`);
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Publishes a Reel (vertical video). Creates the media container, waits for the
 * async video processing to finish, then publishes it. Returns the media id.
 */
async function publishReel({ videoUrl, caption, coverUrl, maxWaitMs = 120000 }) {
  if (!isConfigured()) throw new Error("Instagram not configured (IG_USER_ID / IG_ACCESS_TOKEN)");
  const c = cfg();

  const container = await graph("POST", `${c.userId}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    ...(coverUrl ? { cover_url: coverUrl } : {}),
    share_to_feed: "true",
  });
  const creationId = container.id;

  // Video processing is async — poll the container until it's FINISHED.
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const st = await graphGet(creationId, { fields: "status_code,status" });
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR") {
      throw new Error(`Reel processing failed: ${st.status || "ERROR"}`);
    }
    if (Date.now() > deadline) throw new Error("Reel processing timed out");
    await sleep(4000);
  }

  const published = await graph("POST", `${c.userId}/media_publish`, {
    creation_id: creationId,
  });
  return published.id;
}

/** Publishes a single image. Returns the media id. */
async function publishImage({ imageUrl, caption }) {
  if (!isConfigured()) throw new Error("Instagram not configured (IG_USER_ID / IG_ACCESS_TOKEN)");
  const c = cfg();
  const container = await graph("POST", `${c.userId}/media`, {
    image_url: imageUrl,
    caption,
  });
  const published = await graph("POST", `${c.userId}/media_publish`, {
    creation_id: container.id,
  });
  return published.id;
}

module.exports = { isConfigured, publishReel, publishImage };
