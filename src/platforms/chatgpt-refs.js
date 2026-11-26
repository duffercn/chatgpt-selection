// Rewrites ChatGPT's private citation markers in assistant text using
// message.metadata.content_references.
//
// Web answers carry markers built from Unicode private-use characters, e.g.
// `\uE200cite\uE202turn0search0\uE201`, `\uE200url\uE202Title\uE202turn0search2\uE201`
// or `\uE200image_group\uE202{...}\uE201`. Each reference lists the marker it
// stands for (matched_text) and the readable replacement (alt). Anything left
// over is stripped so the copied text never contains private-use characters.

import { stripQueryParams } from "../core/rich.js";

// A leftover marker is dropped whole: U+E200 opens it, U+E201 closes it, and U+E202
// separates its arguments. Applied until none remain, so none can leak into the copy.
const OPEN_MARKER = /\uE200[^]*?\uE201/gu;
const STRAY_MARKER = /[\uE201-\uE2FF]/gu;

function dropMarkers(text) {
  let out = text;
  for (let guard = 0; guard < 100 && OPEN_MARKER.test(out); guard += 1) {
    OPEN_MARKER.lastIndex = 0;
    out = out.replace(OPEN_MARKER, "");
  }
  OPEN_MARKER.lastIndex = 0;
  return out.replace(STRAY_MARKER, "");
}

// ChatGPT's own click-tracking parameter, dropped from every URL it emits.
// The URLs here are hand-written `alt` links inside a citation, so the pair is
// removed as written and the rest of the URL is left byte-for-byte.
const TRACKING_PARAMS = ["utm_source=chatgpt.com"];

function stripTracking(url) {
  return stripQueryParams(url, TRACKING_PARAMS, { bare: true });
}

function cleanAlt(alt) {
  return String(alt).replace(/https?:\/\/[^\s()\]]+/g, (url) => stripTracking(url));
}

function imageQuery(ref) {
  let data = null;
  const marker = String(ref.matched_text || "").trim();
  const body = /^\uE200image_group\uE202([^]*?)\uE201?$/u.exec(marker);
  try {
    data = JSON.parse(body ? body[1] : "");
  } catch {
    return "";
  }
  const queries = Array.isArray(data?.query) ? data.query : [];
  return queries.filter((q) => typeof q === "string" && q.trim()).join(" · ");
}

function writingBlock(ref, text) {
  const content = ref?.data?.content;
  if (typeof content !== "string" || !content.trim()) return null;
  if (!text.includes(content)) return null;
  const matched = String(ref.matched_text || "");
  // The marker wraps the document body in `:::writing{...}` fences; drop the fences.
  if (matched) return text.replace(matched, () => content);
  return text.replace(content, () => content);
}

function replacement(ref, text) {
  switch (ref?.type) {
    case "grouped_webpages":
    case "url":
      return typeof ref.alt === "string" ? cleanAlt(ref.alt) : null;
    case "image_group": {
      const queries = imageQuery(ref);
      return queries ? `[Images: ${queries}]` : "[Images]";
    }
    case "hidden":
      return "";
    case "sources_footnote":
      // Page numbers / leading spaces: keep the text as written.
      return null;
    case "client_defined_widget": {
      // Only a writing block hides text behind a marker; code blocks and charts
      // already appear verbatim in the message text.
      if (ref.category !== "writing_block") return null;
      const body = ref?.data?.content;
      return typeof body === "string" && body.trim() ? body : null;
    }
    default:
      return null;
  }
}

function replaceReference(ref, text) {
  const matched = String(ref?.matched_text || "");
  const next = replacement(ref, text);
  if (next === null) return text;
  if (matched && text.includes(matched)) return text.split(matched).join(next);
  if (ref?.type === "client_defined_widget") return writingBlock(ref, text);
  return text;
}

export function replaceCitationMarkers(text, references) {
  let out = String(text ?? "");
  if (Array.isArray(references)) {
    for (const ref of references) {
      if (!ref || typeof ref !== "object") continue;
      out = replaceReference(ref, out);
    }
  }
  // Anything a reference did not explain is dropped whole, arguments included.
  return dropMarkers(out);
}
