"use strict";

const crypto = require("crypto");
const config = require("./config");

/**
 * Verifies the Meta webhook payload signature (X-Hub-Signature-256). Requires
 * the raw request body and the app secret.
 *
 * @param {Buffer|string} rawBody The exact bytes Meta sent.
 * @param {string} signatureHeader Value of the `x-hub-signature-256` header.
 * @returns {boolean}
 */
function verifySignature(rawBody, signatureHeader) {
  if (!config.appSecret) return true; // dev mode without secret configured
  if (!signatureHeader) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", config.appSecret).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch (_) {
    return false;
  }
}

module.exports = { verifySignature };
