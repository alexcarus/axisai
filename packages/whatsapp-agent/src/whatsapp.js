"use strict";

const config = require("./config");
const logger = require("./logger");

/**
 * Meta WhatsApp Business Cloud API client. Sends text, reply buttons and
 * interactive list messages via the Graph API (global fetch, Node 18+).
 */
const BASE = () =>
  `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;

async function send(payload) {
  if (!config.accessToken || !config.phoneNumberId) {
    logger.warn("WhatsApp send skipped — META_ACCESS_TOKEN/PHONE_NUMBER_ID not set", {
      to: payload.to,
    });
    return { skipped: true };
  }
  try {
    const res = await fetch(BASE(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) logger.error("WhatsApp API error", { status: res.status, body });
    return body;
  } catch (err) {
    logger.error("WhatsApp send failed", { error: err.message });
    return { error: err.message };
  }
}

/** Sends a plain text message. */
function sendText(to, text) {
  return send({ to, type: "text", text: { preview_url: false, body: text.slice(0, 4096) } });
}

/**
 * Sends up to 3 reply buttons.
 * @param {Array<{id:string,title:string}>} buttons
 */
function sendButtons(to, body, buttons) {
  return send({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body.slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

/**
 * Sends an interactive list message.
 * @param {Array<{id:string,title:string,description?:string}>} rows
 */
function sendList(to, header, body, buttonText, rows) {
  return send({
    to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: header.slice(0, 60) },
      body: { text: body.slice(0, 1024) },
      action: {
        button: buttonText.slice(0, 20),
        sections: [
          {
            title: "Work Types",
            rows: rows.slice(0, 10).map((r) => ({
              id: r.id,
              title: r.title.slice(0, 24),
              description: (r.description || "").slice(0, 72),
            })),
          },
        ],
      },
    },
  });
}

module.exports = { sendText, sendButtons, sendList };
