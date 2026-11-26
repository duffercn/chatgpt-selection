// Private evidence for the optional real-data tests.
//
// Every optional test that replays recorded conversations reads its files from
// one directory named by `CHATCOPY_EVIDENCE`. The recordings are private: they
// are never committed to this repository and are only referenced through this
// module, so a missing directory simply means the tests are skipped.
//
//   CHATCOPY_EVIDENCE=/path/to/private-evidence npx vitest run
//
// Layout below that directory:
//
//   chatgpt-dil/            a<N>.txt DIL replies
//   claude-rich/            conversation.json
//   doubao-rich/            raw.json
//   survey/chatgpt/         <i>.raw.json (+ <i>.url)
//   survey/claude/          <i>.raw.json
//   survey/doubao/          <i>.raw.json (+ <i>.url)
//   survey/deepseek/        <i>.raw.json (+ <i>.url)
//   survey/grok/            <i>.raw.json (+ <i>.url)
//
// Use `evidenceFiles()` for a survey directory: it returns [] when the whole
// directory is absent, so `describe.skipIf(!files().length)` skips cleanly.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The evidence root, or "" when `CHATCOPY_EVIDENCE` is unset. */
export const EVIDENCE_ROOT = process.env.CHATCOPY_EVIDENCE || "";

/** A path below the evidence root; "" when the root is unset. */
export function evidencePath(...parts) {
  return EVIDENCE_ROOT ? join(EVIDENCE_ROOT, ...parts) : "";
}

/** A path below the evidence root, or "" when that file is not present. */
export function evidenceFile(...parts) {
  const path = evidencePath(...parts);
  return path && existsSync(path) ? path : "";
}

/** `survey/<site>` for one platform. */
export function surveyDir(site) {
  return evidencePath("survey", site);
}

/**
 * Numbered raw responses in a survey directory, in numeric order:
 * `[{ index, file, path, urlPath }]`. Empty when the directory is missing.
 */
export function evidenceFiles(dir, { withUrl = false } = {}) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d+\.raw\.json$/.test(name))
    .map((name) => {
      const index = Number.parseInt(name, 10);
      const urlPath = withUrl ? join(dir, `${index}.url`) : "";
      return { index, file: name, path: join(dir, name), urlPath: urlPath && existsSync(urlPath) ? urlPath : "" };
    })
    .sort((a, b) => a.index - b.index);
}
