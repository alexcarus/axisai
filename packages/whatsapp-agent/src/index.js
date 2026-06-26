"use strict";

const express = require("express");
const config = require("./config");
const logger = require("./logger");
const { verifySignature } = require("./signature");
const { handleMessage } = require("./flows");
const { userStore } = require("./context");
const redis = require("./redis");

const app = express();

// Capture the raw body for webhook signature verification.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

/**
 * GET /webhook — Meta verification handshake.
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === config.verifyToken) {
    logger.info("WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * Extracts a normalized message from the Meta webhook payload.
 * @returns {{ from:string, msg:{text?:string, interactiveId?:string} }|null}
 */
function extractMessage(body) {
  try {
    const value = body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return null;
    const from = message.from;

    if (message.type === "text") {
      return { from, msg: { text: message.text?.body || "" } };
    }
    if (message.type === "interactive") {
      const it = message.interactive;
      if (it?.type === "list_reply") return { from, msg: { interactiveId: it.list_reply.id, text: it.list_reply.title } };
      if (it?.type === "button_reply") return { from, msg: { interactiveId: it.button_reply.id, text: it.button_reply.title } };
    }
    if (message.type === "button") {
      return { from, msg: { interactiveId: message.button?.payload, text: message.button?.text } };
    }
    // Other message types fall back to help.
    return { from, msg: { text: "" } };
  } catch (err) {
    logger.error("extractMessage failed", { error: err.message });
    return null;
  }
}

/**
 * POST /webhook — incoming WhatsApp messages.
 */
app.post("/webhook", async (req, res) => {
  // Verify signature before processing anything.
  if (!verifySignature(req.rawBody, req.headers["x-hub-signature-256"])) {
    logger.warn("WhatsApp webhook signature verification failed");
    return res.sendStatus(401);
  }

  // Acknowledge immediately (Meta expects a fast 200); process async.
  res.sendStatus(200);

  const extracted = extractMessage(req.body);
  if (!extracted) return;

  logger.info("WhatsApp message", { from: extracted.from, msg: extracted.msg });
  try {
    await handleMessage(extracted.from, extracted.msg);
  } catch (err) {
    logger.error("handleMessage threw", { error: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", service: "axis-whatsapp" }));

const server = app.listen(config.port, config.host, () => {
  logger.info(`WhatsApp agent listening on ${config.host}:${config.port}`);
});

const shutdown = async (sig) => {
  logger.info(`WhatsApp agent received ${sig}, shutting down`);
  server.close(async () => {
    await userStore.close().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = { app };
