// Doubao prose-block enrichment: inline citations (meta type 2) and inline
// media cards (meta type 202) are rendered as static Markdown, and search
// queries (10025) become a leading line. Only text, links and captions are
// kept; signed media URLs (thumb/full size) expire and are never copied.
//
// References follow the reply, not the retrieval set: a search card (10025) or
// a legacy `search_references` entry is only listed when the reply cites it
// inline. Cards nobody cited are Doubao's search results, not the reply's
// sources, so a reply with cards but no inline citation lists no sources.

import { CopyError, ErrorCode } from "../core/errors.js";
import { citationLink, hostName, isWebUrl, stripQueryParams, webSearchLine } from "../core/rich.js";

const encoder = new TextEncoder(), decoder = new TextDecoder();
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const webUrl = (value) => typeof value === "string" ? value.trim() : "";

// Doubao citation links carry analytics parameters, not content.
const TRACKING_PARAMS = ["f_link_type", "flow_extra"];

function fail() {
  throw new CopyError(ErrorCode.INVALID_RESPONSE, "Doubao: An unknown or unfinished rich block cannot be copied safely.");
}

/** Legacy meta entries carry only `type` and `info`; there is no `tag_info`. */
function legacyInfo(entry) {
  if (typeof entry?.info !== "string") fail();
  try {
    return JSON.parse(entry.info);
  } catch {
    return fail();
  }
}

function marker(entry) {
  if (typeof entry?.tag_info !== "string" || typeof entry?.info !== "string") fail();
  try {
    return JSON.parse(entry.info);
  } catch {
    return fail();
  }
}

/** `pos` is a UTF-8 byte offset into the prose; it may be a one-element array. */
function bytePos(value) {
  const pos = Array.isArray(value) ? value[0] : value;
  return typeof pos === "number" && Number.isInteger(pos) && pos >= 0 ? pos : fail();
}

/** Drops tracking params from a citation URL, keeping other queries intact. */
export function cleanCitationUrl(url) {
  return stripQueryParams(url, TRACKING_PARAMS);
}

/**
 * Reads a citation and returns `{url, title}` with the tracking-stripped URL,
 * or "" when it points at nothing copyable. `title` prefers the citation's own
 * labels; the caller may still resolve it against a search card.
 */
function citationSource(info) {
  const url = webUrl(info?.url);
  if (!isWebUrl(url)) return "";
  const cleaned = cleanCitationUrl(url);
  const title = webUrl(info?.title) || webUrl(info?.website_name) || hostName(cleaned);
  return { title, url: cleaned };
}

/**
 * Position-ordered citations from a prose block's `meta_info`, oldest first.
 * Entries have already been validated by `renderRichText`; the media entries
 * (type 202) carry no source and are skipped.
 */
export function proseCitations(metaInfo) {
  const sources = [];
  for (const entry of metaInfo) {
    if (entry.type !== 2) continue;
    const info = marker(entry);
    const source = citationSource(isObject(info) ? info : null);
    if (source) sources.push({ ...source, pos: bytePos(info.pos) });
  }
  return sources.sort((a, b) => a.pos - b.pos);
}

/** Position-ordered citations from a legacy message's `ext.meta_info`, oldest first. */
export function legacyCitations(entries) {
  const sources = [];
  for (const entry of entries) {
    if (!isObject(entry) || (entry.type !== 2 && entry.type !== -4)) fail();
    const source = citationSource(legacyInfo(entry));
    if (source) sources.push(source);
  }
  return sources;
}

/**
 * The reply's sources, in the order it cites them: one `{title, url}` per
 * tracking-stripped citation URL. A card with the same URL (compared after the
 * same cleanup) supplies the title; otherwise the citation's own label does.
 */
export function citedReferences(citations, cards = []) {
  const titles = new Map();
  for (const card of cards) {
    const url = webUrl(card?.url);
    if (!isWebUrl(url)) continue;
    const cleaned = cleanCitationUrl(url);
    const title = webUrl(card?.title);
    if (!titles.has(cleaned) || (!titles.get(cleaned) && title)) titles.set(cleaned, title);
  }
  const references = [], seen = new Set();
  for (const citation of citations) {
    if (seen.has(citation.url)) continue;
    seen.add(citation.url);
    references.push({ title: titles.get(citation.url) || citation.title, url: citation.url });
  }
  return references;
}

function citationLine(entry) {
  const url = webUrl(entry.url);
  if (!isWebUrl(url)) return "";
  const label = webUrl(entry.website_name) || webUrl(entry.insert_text).replace(/^\(|\)$/g, "") || new URL(url).hostname;
  return citationLink(label, cleanCitationUrl(url));
}

function imageLine(image) {
  if (!isObject(image)) fail();
  const label = webUrl(image.img_caption) || "image";
  const url = webUrl(image.main_site_url);
  return isWebUrl(url) ? `[Image: ${label}](${url})` : `[Image: ${label}]`;
}

function videoLine(video) {
  if (!isObject(video)) fail();
  const caption = (webUrl(video.video_captions).split("\n")[0] || "").trim().slice(0, 80);
  const source = webUrl(video.source_app_name);
  const text = [caption || "video", source].filter(Boolean).join(" · ");
  const url = webUrl(video.main_site_url);
  return isWebUrl(url) ? `[Video: ${text}](${url})` : `[Video: ${text}]`;
}

function mediaLines(entry) {
  if (!Array.isArray(entry.media) || !entry.media.length) fail();
  return entry.media.map((item) => {
    if (item?.type === 1) return imageLine(item.image);
    if (item?.type === 2) return videoLine(item.video);
    return fail();
  });
}

/** Applies byte-offset insertions from the end so earlier offsets stay valid. */
function spliceBytes(text, insertions) {
  const bytes = encoder.encode(text);
  let output = bytes, last = bytes.length;
  for (const { pos, snippet } of insertions) {
    const at = Math.min(Math.max(pos, 0), Math.min(last, bytes.length));
    // Snap back off any continuation byte so a multibyte character is never split.
    let start = at;
    while (start > 0 && (bytes[start] & 0xc0) === 0x80) start -= 1;
    output = new Uint8Array([...output.slice(0, start), ...encoder.encode(snippet), ...output.slice(start)]);
    last = start;
  }
  return decoder.decode(output);
}

/**
 * Renders the prose block's meta_info entries into the text. Unknown entry or
 * media types are rejected: a silently dropped rich block would lose content.
 */
export function renderRichText(text, metaInfo) {
  if (!Array.isArray(metaInfo)) fail();
  const insertions = [];
  for (const entry of metaInfo) {
    if (!isObject(entry)) fail();
    const info = marker(entry);
    if (entry.type === 2) {
      const snippet = citationLine(isObject(info) ? info : fail());
      if (snippet) insertions.push({ pos: bytePos(info.pos), snippet });
    } else if (entry.type === 202) {
      if (!isObject(info)) fail();
      insertions.push({ pos: bytePos(info.pos), snippet: `\n\n${mediaLines(info).join("\n")}\n\n` });
    } else {
      fail();
    }
  }
  if (!insertions.length) return text;
  insertions.sort((a, b) => b.pos - a.pos);
  return spliceBytes(text, insertions);
}

/**
 * Legacy messages (content_type 1) carry their citations in `ext.meta_info`
 * instead of inside a prose block. Offsets there are UTF-16 code-unit indexes
 * (the entry repeats them as `pos_rune`), not the UTF-8 byte offsets used by
 * prose blocks. Entries with an empty `pos` array carry no position, so their
 * link is left out of the prose; the caller still lists them as references.
 */
export function renderLegacyRichText(text, entries) {
  if (!Array.isArray(entries)) fail();
  const insertions = [];
  for (const entry of entries) {
    if (!isObject(entry) || (entry.type !== 2 && entry.type !== -4)) fail();
    const info = legacyInfo(entry);
    if (!isObject(info)) fail();
    const snippet = citationLine(info);
    const positions = Array.isArray(info.pos) ? info.pos : null;
    if (positions === null) fail();
    if (!positions.length) continue;
    const pos = positions[0];
    if (typeof pos !== "number" || !Number.isInteger(pos) || pos < 0) fail();
    if (snippet) insertions.push({ pos, snippet });
  }
  if (!insertions.length) return text;
  insertions.sort((a, b) => b.pos - a.pos);
  let output = text;
  for (const { pos, snippet } of insertions) output = output.slice(0, Math.min(pos, output.length)) + snippet + output.slice(Math.min(pos, output.length));
  return output;
}


/** The leading `[Web search: …]` line for a reply that ran a 10025 search. */
export function searchNoticeLine(queries) {
  if (!Array.isArray(queries)) return "";
  const line = webSearchLine(queries);
  return line === webSearchLine([]) ? "" : `${line}\n\n`;
}
