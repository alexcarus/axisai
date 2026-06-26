// ---------------------------------------------------------------------------
// Idempotent patch for Vocs 2.0.10 — fixes Windows-only path bugs that break
// `vite build` / `vite dev` outside a POSIX environment. Runs on postinstall so
// it survives reinstalls. Safe no-op on non-Windows / already-patched trees.
//
// 1. dist/internal/mdx.js — getMdxLayoutImport() compared paths with strict
//    string equality, so on Windows (forward- vs back-slash) the base case never
//    matched and the directory walk recursed past the filesystem root
//    (RangeError: Maximum call stack size exceeded). Normalize + guard the root.
//
// 2. dist/internal/vite-plugins.js — userStyles()/slots() interpolated absolute
//    Windows paths (with backslashes) straight into `import '...'` strings, so
//    `\f`, `\U`, etc. became JS escape sequences and the module couldn't be
//    found (ERR_MODULE_NOT_FOUND on every doc-layout page). Use POSIX separators.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function vocsDir() {
  try {
    return path.dirname(require.resolve("vocs/package.json"));
  } catch {
    // Fallback: resolve the entry and walk up to the package root.
    try {
      let dir = path.dirname(require.resolve("vocs"));
      for (let i = 0; i < 6; i++) {
        if (existsSync(path.join(dir, "package.json"))) return dir;
        dir = path.dirname(dir);
      }
    } catch {
      /* not installed */
    }
  }
  return null;
}

function patchFile(file, alreadyPatched, transform, label) {
  if (!existsSync(file)) return;
  const src = readFileSync(file, "utf8");
  if (alreadyPatched(src)) return; // idempotent
  const out = transform(src);
  if (out !== src) {
    writeFileSync(file, out, "utf8");
    console.log(`[patch-vocs] patched ${label}`);
  }
}

function run() {
  const dir = vocsDir();
  if (!dir) return; // vocs not present yet — nothing to do

  // --- 1. mdx.js layout-resolution recursion ---
  patchFile(
    path.join(dir, "dist/internal/mdx.js"),
    (s) => s.includes("path.resolve(dir) === path.resolve(path.dirname(pagesDirPath))"),
    (s) =>
      s.replace(
        "if (dir === path.dirname(pagesDirPath))",
        "if (path.resolve(dir) === path.resolve(path.dirname(pagesDirPath)) || path.dirname(dir) === dir)",
      ),
    "mdx.js (layout recursion)",
  );

  // --- 2. vite-plugins.js import-path backslashes ---
  const POSIX = "split(String.fromCharCode(92)).join('/')";
  patchFile(
    path.join(dir, "dist/internal/vite-plugins.js"),
    (s) => s.includes("String.fromCharCode(92)") || s.includes("stylesImport"),
    (s) =>
      s
        .replaceAll("${stylesPath}?url", `\${stylesPath.${POSIX}}?url`)
        .replaceAll("${stylesPath}?inline", `\${stylesPath.${POSIX}}?inline`)
        .replaceAll("from '${slotsPath}'", `from '\${slotsPath.${POSIX}}'`),
    "vite-plugins.js (import paths)",
  );
}

try {
  run();
} catch (err) {
  // Never fail the install over a best-effort patch.
  console.warn(`[patch-vocs] skipped: ${err?.message ?? err}`);
}
