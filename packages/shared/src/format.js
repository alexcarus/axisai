"use strict";

/**
 * Formatting helpers shared across messaging interfaces.
 */

/** Renders a unicode text progress bar. */
function progressBar(fraction, width = 20) {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  const filled = Math.round(f * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Truncates an EVM address to 0xabcd…wxyz form. */
function truncateAddress(addr) {
  if (!addr || addr.length < 12) return addr || "";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Escapes text for Telegram MarkdownV2. */
function escapeMarkdownV2(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (m) => "\\" + m);
}

/** Formats an AXIS amount (string/number) to a fixed number of decimals. */
function formatAxis(amount, decimals = 4) {
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return String(amount);
  return n.toLocaleString("en-US", { maximumFractionDigits: decimals });
}

/** Human percentage from a 0..100 number. */
function formatPercent(pct, decimals = 2) {
  const n = Number(pct || 0);
  return `${n.toFixed(decimals)}%`;
}

module.exports = {
  progressBar,
  truncateAddress,
  escapeMarkdownV2,
  formatAxis,
  formatPercent,
};
