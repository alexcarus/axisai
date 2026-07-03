"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Local rotation + post history so runs vary and are auditable. Gitignored.
const STATE_FILE = path.join(__dirname, ".axis-marketing-state.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (_) {
    return { counter: 0, history: [] };
  }
}

function save(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (_) {
    /* best-effort — a read-only FS just means less rotation memory */
  }
}

/** Records a published post and advances the rotation counter. */
function record(state, entry) {
  const next = {
    counter: (state.counter || 0) + 1,
    history: [
      { ...entry, at: new Date().toISOString() },
      ...(state.history || []),
    ].slice(0, 50),
  };
  save(next);
  return next;
}

module.exports = { load, save, record, STATE_FILE };
