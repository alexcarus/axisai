"use strict";

const { escapeMarkdownV2 } = require("@axis/shared");

/**
 * Minimal MarkdownV2 builder. Every literal string is escaped; formatting markers
 * are added by helpers and intentionally NOT escaped. This guarantees valid
 * MarkdownV2 without hand-escaping every period and hyphen.
 */
const esc = (t) => escapeMarkdownV2(t == null ? "" : String(t));
const b = (t) => `*${esc(t)}*`; // bold
const i = (t) => `_${esc(t)}_`; // italic
const code = (t) => `\`${esc(t)}\``; // inline code
const plain = (t) => esc(t);
const link = (text, url) => `[${esc(text)}](${url})`;

/** Joins lines with newlines (newlines are MarkdownV2-safe). */
const lines = (...parts) => parts.filter((p) => p !== undefined && p !== null).join("\n");

module.exports = { esc, b, i, code, plain, link, lines };
