"use strict";

const config = require("./config");
const logger = require("./logger");

/**
 * Thin proxy to the verification engine using the global fetch (Node 18+).
 * Returns { status, body } and never throws into the request path.
 */
async function forward(method, path, { body, query } = {}) {
  let url = `${config.engineUrl}${path}`;
  if (query && Object.keys(query).length) {
    const qs = new URLSearchParams(query).toString();
    url += `?${qs}`;
  }

  const init = { method, headers: { "Content-Type": "application/json" } };
  if (config.engineInternalKey) init.headers["x-internal-key"] = config.engineInternalKey;
  if (body !== undefined) init.body = JSON.stringify(body);

  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch (_) {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed };
  } catch (err) {
    logger.error("engine forward failed", { path, error: err.message });
    return { status: 502, body: { error: "engine unreachable", detail: err.message } };
  }
}

/**
 * Health probe to the engine. Returns true if the engine /health is reachable.
 */
async function engineHealthy() {
  try {
    const res = await fetch(`${config.engineUrl}/health`, { method: "GET" });
    return res.ok;
  } catch (_) {
    return false;
  }
}

module.exports = { forward, engineHealthy };
