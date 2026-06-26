"use strict";

const Fastify = require("fastify");
const config = require("./config");
const logger = require("./logger");
const { migrate, audit, flagForReview, pool } = require("./db");
const redis = require("./redis");
const { verifySubmission, verifyAuthHeaders } = require("./auth");
const rl = require("./rateLimit");
const { consumeNonce } = require("./nonce");
const { trackWalletIp } = require("./anomaly");
const { forward, engineHealthy } = require("./proxy");

const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 6 * 1024 * 1024 });

// --------------------------------------------------------------------------- //
//                                   CORS                                       //
// --------------------------------------------------------------------------- //
// The in-browser AXIS miner submits and reads cross-origin, so every response
// needs CORS headers and preflight (OPTIONS) requests must be answered before
// the auth/rate-limit guards run. Dependency-free so no extra install is needed.
const CORS_ALLOWED = config.corsOrigin
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function resolveCorsOrigin(req) {
  if (CORS_ALLOWED.includes("*")) return "*";
  const origin = req.headers.origin;
  return origin && CORS_ALLOWED.includes(origin) ? origin : CORS_ALLOWED[0] || "";
}

app.addHook("onRequest", async (req, reply) => {
  const allow = resolveCorsOrigin(req);
  if (allow) {
    reply.header("access-control-allow-origin", allow);
    if (allow !== "*") reply.header("vary", "Origin");
  }
  reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
  reply.header(
    "access-control-allow-headers",
    "Content-Type,x-channel,x-wallet-address,x-timestamp,x-signature",
  );
  reply.header("access-control-max-age", "86400");
  if (req.method === "OPTIONS") {
    reply.code(204).send();
    return reply;
  }
});

// Explicit preflight route so OPTIONS always matches and the CORS hook fires.
// (The hook above already sends the 204; this is the deterministic fallback.)
app.options("/*", async (_req, reply) => reply.code(204).send());

/** Resolves the client IP, honouring X-Forwarded-For via trustProxy. */
function clientIp(req) {
  return req.ip || (req.headers["x-forwarded-for"] || "").split(",")[0] || "unknown";
}

/** Common IP defence applied to every gateway route. */
async function ipGuard(req, reply) {
  const ip = clientIp(req);
  if (await rl.isBanned(ip)) {
    await audit({ ip, route: req.url, result: "rejected", detail: "ip banned" });
    reply.code(403).send({ error: "temporarily banned" });
    return false;
  }
  const ipRate = await rl.checkIpRate(ip);
  if (!ipRate.allowed) {
    const banned = await rl.recordViolation(ip);
    await audit({ ip, route: req.url, result: "rejected", detail: `ip rate exceeded (${ipRate.count})` });
    reply.code(429).send({ error: "rate limit exceeded", limit: ipRate.limit, banned });
    return false;
  }
  return true;
}

/** Auth guard for read endpoints (signed challenge headers). */
async function readAuthGuard(req, reply) {
  const wallet = verifyAuthHeaders(req.headers);
  if (!wallet) {
    await audit({ ip: clientIp(req), route: req.url, result: "rejected", detail: "unsigned/invalid auth" });
    reply.code(401).send({ error: "missing or invalid signed auth headers" });
    return null;
  }
  return wallet;
}

// --------------------------------------------------------------------------- //
//                              POST /gateway/submit                           //
// --------------------------------------------------------------------------- //
app.post("/gateway/submit", async (req, reply) => {
  const ip = clientIp(req);
  const channel = req.headers["x-channel"] || (req.body && req.body.channel) || "api";
  const body = req.body || {};
  const wallet = body.wallet_address;
  const workType = body.work_type;

  if (!(await ipGuard(req, reply))) return;

  // 1. Authentication — verify the submission signature before anything else.
  if (!verifySubmission(body)) {
    await rl.recordViolation(ip);
    await audit({ channel, wallet, work_type: workType, ip, route: req.url, result: "rejected", detail: "bad signature" });
    return reply.code(401).send({ error: "signature verification failed" });
  }

  // 2. Wallet ban + cross-channel cooldown.
  if (await rl.isBanned(wallet.toLowerCase())) {
    await audit({ channel, wallet, ip, route: req.url, result: "rejected", detail: "wallet banned" });
    return reply.code(403).send({ error: "wallet temporarily banned" });
  }
  const cooldown = await rl.checkWalletCooldown(wallet);
  if (!cooldown.allowed) {
    await audit({ channel, wallet, work_type: workType, ip, route: req.url, result: "rejected", detail: "wallet cooldown" });
    return reply.code(429).send({ error: "wallet submission cooldown", retry_after_seconds: cooldown.retryAfter });
  }

  // 3. Nonce enforcement (duplicate => reject + flag).
  const nonceRes = await consumeNonce(body);
  if (!nonceRes.ok) {
    await rl.recordViolation(wallet.toLowerCase());
    await flagForReview(wallet, "nonce_violation", { reason: nonceRes.reason });
    await audit({ channel, wallet, work_type: workType, ip, route: req.url, result: "rejected", detail: nonceRes.reason });
    return reply.code(400).send({ error: "nonce rejected", reason: nonceRes.reason });
  }

  // 4. Anomaly detection — multi-IP per wallet.
  const anomaly = await trackWalletIp(wallet, ip);

  // 5. Open the cross-channel cooldown window and forward to the engine.
  await rl.markWalletSubmission(wallet);
  const { status, body: engineBody } = await forward("POST", "/submit", { body });

  const result = status >= 200 && status < 300 ? "forwarded" : "error";
  await audit({
    channel,
    wallet,
    work_type: workType,
    ip,
    route: req.url,
    result,
    detail: `engine ${status}${anomaly.flagged ? " | flagged:multi_ip" : ""}`,
  });

  return reply.code(status).send(engineBody);
});

// --------------------------------------------------------------------------- //
//                              READ ENDPOINTS                                  //
// --------------------------------------------------------------------------- //
app.get("/gateway/status/:jobId", async (req, reply) => {
  if (!(await ipGuard(req, reply))) return;
  const wallet = await readAuthGuard(req, reply);
  if (!wallet) return;
  const { status, body } = await forward("GET", `/status/${encodeURIComponent(req.params.jobId)}`);
  await audit({ wallet, ip: clientIp(req), route: req.url, result: "forwarded", detail: `engine ${status}` });
  return reply.code(status).send(body);
});

app.get("/gateway/miner/:wallet", async (req, reply) => {
  if (!(await ipGuard(req, reply))) return;
  const wallet = await readAuthGuard(req, reply);
  if (!wallet) return;
  const { status, body } = await forward("GET", `/miner/${encodeURIComponent(req.params.wallet)}`);
  await audit({ wallet, ip: clientIp(req), route: req.url, result: "forwarded", detail: `engine ${status}` });
  return reply.code(status).send(body);
});

app.get("/gateway/network/stats", async (req, reply) => {
  if (!(await ipGuard(req, reply))) return;
  const wallet = await readAuthGuard(req, reply);
  if (!wallet) return;
  const { status, body } = await forward("GET", "/network/stats");
  return reply.code(status).send(body);
});

app.get("/gateway/leaderboard", async (req, reply) => {
  if (!(await ipGuard(req, reply))) return;
  const wallet = await readAuthGuard(req, reply);
  if (!wallet) return;
  const { status, body } = await forward("GET", "/network/leaderboard");
  return reply.code(status).send(body);
});

// --------------------------------------------------------------------------- //
//                                 HEALTH                                       //
// --------------------------------------------------------------------------- //
app.get("/health", async (req, reply) => {
  const health = { status: "ok", service: "axis-gateway", time: new Date().toISOString() };
  try {
    await pool.query("SELECT 1");
    health.postgres = "ok";
  } catch (_) {
    health.postgres = "down";
    health.status = "degraded";
  }
  try {
    await redis.ping();
    health.redis = "ok";
  } catch (_) {
    health.redis = "down";
    health.status = "degraded";
  }
  health.engine = (await engineHealthy()) ? "ok" : "down";
  if (health.engine !== "ok") health.status = "degraded";
  return reply.code(health.status === "ok" ? 200 : 503).send(health);
});

// --------------------------------------------------------------------------- //
//                               BOOTSTRAP                                      //
// --------------------------------------------------------------------------- //
async function start() {
  await migrate();
  await app.listen({ port: config.port, host: config.host });
  logger.info(`AXIS gateway listening on ${config.host}:${config.port}`);
}

const shutdown = async (sig) => {
  logger.info(`Gateway received ${sig}, shutting down`);
  try {
    await app.close();
    await redis.quit();
    await pool.end();
  } catch (_) {
    /* best effort */
  }
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch((err) => {
  logger.error("Gateway startup failed", { error: err.message });
  process.exit(1);
});

module.exports = { app };
