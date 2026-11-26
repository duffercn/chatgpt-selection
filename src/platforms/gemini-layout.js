// Gemini hNvQHb history layout, as observed in the 25-conversation survey of
// 2026-11-26 (private-evidence/survey/gemini). Every index below is named so the
// parser reads as a description of the payload instead of a wall of numbers.
//
// Verifying a change to this file: re-run the survey tests with
// CHATCOPY_EVIDENCE pointing at the recordings; a layout change shows up as
// INVALID_RESPONSE or as a new `[Gemini content: …]` placeholder.

/**
 * `data` (the decoded hNvQHb payload): `[records, ?, ?, tail, …]`.
 *
 * Records are newest-first. Slots 1 and 2 were `null` in all 25 recordings and
 * are the only pagination candidates we know of (a continuation cursor would
 * have to travel there or in the request, not inside the records).
 */
export const HISTORY = Object.freeze({
  records: 0,
  pagination: [1, 2],
  tail: 3
});

/** One record (one turn). 16 fields; the previous layout had 5. */
export const RECORD = Object.freeze({
  ids: 0, // [c_<id>, r_<id>]
  parent: 1, // null for the oldest turn, else [c_<id>, r_<older id>, rc_<older selected candidate>]
  user: 2, // user message, 5/7/9/11 fields (see USER)
  response: 3, // assistant response, 32 fields (see RESPONSE)
  timestamp: 4, // [seconds, nanos]
  // 5..14 were null in every recording; not read.
  uuid: 15 // per-record UUID
});

export const USER = Object.freeze({
  payload: 0, // 5 or 7 fields (see USER_PAYLOAD)
  // 1 was the constant 2; 3 was 0 (edited) or 1; 4 a 16-char id shared by the
  // whole conversation; 5/6/7/8/9 were null, 0, 1 or [1]; all not visible.
  flags: 10 // `[]`, or `[true]` on turns that carry a user action
});

export const USER_PAYLOAD = Object.freeze({
  text: 0, // the prompt (an empty string on one turn whose text lives elsewhere)
  // `[[]]` when there is no attachment; otherwise one entry per upload group:
  //   [null, null, null, [<file>…], [<same file>…], …, [<file>…]]
  // The same file objects are repeated in several slots; slot 3 is the group.
  attachments: 4
});

/** One uploaded file object (16 fields; slots 3 and 5 are signed, expiring). */
export const ATTACHMENT = Object.freeze({
  // In a group `[null, null, null, [[file, …]], [[file, …]], …, [[file, …]]]`
  // every slot after the third repeats the same files; slot 3 is the group.
  group: 3,
  // One file object (16 fields):
  name: 2, // original file name
  mime: 11, // "image/png", "image/jpeg", …
  size: 15 // [width, height, bytes]
  // 5 is a `$Af…`/`$AL…` signing token and 3 an lh3.googleusercontent.com URL
  // carrying it; neither is ever copied.
});

export const RESPONSE = Object.freeze({
  // Alternatives. `candidates[0]` is the selected one (`RESPONSE.id` points at
  // it); one recording had a second, older alternative in `candidates[1]`.
  candidates: 0,
  id: 3, // rc_<id> of the selected candidate
  // 4 holds reasoning steps and tool calls, 5 repeats the tool result. 15 of
  // the 52 recorded turns had entries here: `[null, [], …]` progress steps
  // (2/5/84/245 entries), `[null, ["data_analysis_tool", …, 4]]` tool calls and
  // thinking-step titles ("Reviewing Framework Concepts"). None of it is reply
  // text, so none of it is copied. An image-generation card would be, and the
  // parser keeps that prompt via `extrasMarkers`.
  steps: 4,
  toolResult: 5,
  // 8 ("ST") is the finish reason; 9 `true`/`null` the completed flag.
  // 13 (`[40,40,40]`), 14, 17 (16-char ids), 21 (no tooltip text),
  // 24 (3, or 1 for thinking-heavy turns), 25 (1), 31 ("gemini-…" model id)
  // were all metadata.
  modelLabel: 21, // "3.1 Pro"
  modelId: 31, // "gemini-4-neon"
  decorated: 28 // `true` in one recording; a UI flag we have no meaning for
});

export const CANDIDATE = Object.freeze({
  id: 0, // rc_<id>; equals RESPONSE.id for the selected candidate
  text: 1, // ["<reply Markdown>"] — the visible answer
  // Every index above 1 that is not listed in CANDIDATE_META is either the
  // reasoning block, the rendering AST or a document (see gemini-rich.js).
  reasoning: "detect"
});

/**
 * Candidate fields that may hold something visible. Positions depend on the
 * total length because Gemini appends fields, so a field's meaning is fixed
 * only together with the candidate length seen when it was verified.
 */
export const CANDIDATE_META = Object.freeze({
  // [null, null, 8] next to `id`/`text`, or a 5-field `[false, false, false, false, [null,null,7|8]]`.
  mode: 2,
  // Model-routing / safety flags (`true` on the recordings whose
  // `response[9]` is `null`).
  booleanFlags: [6, 15, 25],
  language: 9, // "en" / "zh"
  // Duplicate rendering AST: `[null,null,null,null,null,null,[0],[]]`, a
  // 32-field version, or a 1-field `{8|56|57: …}` map. Never holds reply prose
  // that is not also in the documents/research payload.
  rendering: 12,
  // Numeric indices into the candidate itself (`[100,104,10,10]`); no strings.
  numericIndex: 43
});

export const DOCUMENT = Object.freeze({
  // [title, …]; kind 2 is a code-backed document (HTML app), 3 a report.
  title: 2,
  kind: 10,
  body: 4, // the full Markdown/HTML body
  citations: 5, // [{ "44": [entry, …] }] — see CITATION
  citationIndex: "44",
  fileName: 9,
  // 17 is [body, …] again and 14 [body, language] for code documents; both are
  // duplicates of `body` and are not read.
  duplicateBody: [14, 17]
});

export const CITATION = Object.freeze({
  // A document's `[5]` is `[{ "44": [entry, …] }]`. Each entry is
  //   [ [" [cite: 1]"],            // 0: the marker text
  //     [source, …] ]              // 1: the sources that marker cited
  // and one source is
  //   [null, null, null, [ [faviconUrl, url, title], number, null, null, null, [ranges] ]]
  // so the payload sits at source[3][0].
  marker: 0,
  groups: 1,
  source: 3,
  detail: 0, // source[3][0] = [faviconUrl, url, title]
  url: 1, // source[3][0][1] — the real destination
  title: 2, // source[3][0][2]
  number: 1 // source[3][1] — the number the `[cite: N]` marker uses
  // source[3][5] holds highlight ranges and source[3][0][0] the favicon
  // (never copied).
});
