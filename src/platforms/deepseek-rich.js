// DeepSeek fragment classification.
//
// A DeepSeek message is a list of fragments. Only a few of them are visible to
// the user; reasoning stages and UI disclaimers are not conversation content.
// Anything we do not recognise still becomes a visible placeholder so that no
// content silently disappears.

import { citationLink, isWebUrl, webSearchLine } from "../core/rich.js";

export function fragmentType(fragment) {
  return String(fragment?.type || fragment?.fragment_type || "").toUpperCase();
}

function contentOf(fragment) {
  if (typeof fragment?.content === "string") return fragment.content;
  if (typeof fragment?.text === "string") return fragment.text;
  if (typeof fragment?.value === "string") return fragment.value;
  return "";
}

// Reasoning stages and disclaimer tips are chrome around the answer, not text
// the user typed or read as part of the reply.
const HIDDEN_TYPES = new Set(["THINKING", "THOUGHT", "REASONING", "THINK", "TIP", "DISCLAIMER"]);
// `TEMPLATE_RESPONSE` is what the user actually saw (for example a "server is
// busy" notice) when the reply never arrived, so its content is the message.
const TEMPLATE_TYPES = new Set(["TEMPLATE_RESPONSE"]);
// Fragment types whose content is the visible reply prose (and where citation
// markers live).
const CITED_TYPES = ["RESPONSE", "TEXT", "MARKDOWN"];

function queryList(fragment) {
  const raw = Array.isArray(fragment?.queries) ? fragment.queries
    : Array.isArray(fragment?.query) ? fragment.query : [];
  return raw
    .map((query) => typeof query === "string" ? query
      : typeof query?.query === "string" ? query.query : "")
    .map((query) => query.trim())
    .filter(Boolean);
}

// `[citation:N]` is the only marker DeepSeek writes inline; a reply cites a
// search result by pointing one of these at the result's `cite_index`.
const CITATION_MARKER = /\[citation:(\d+)\]/gi;

/** `cite_index` values a message's visible reply text cites, in first-cited order. */
export function citedIndexes(fragments) {
  const indexes = [];
  for (const fragment of fragments) {
    // Only the reply text cites sources; reasoning fragments keep their own
    // `references` metadata and are not visible content.
    if (!CITED_TYPES.includes(fragmentType(fragment))) continue;
    for (const match of contentOf(fragment).matchAll(CITATION_MARKER)) {
      const index = Number(match[1]);
      if (Number.isInteger(index) && !indexes.includes(index)) indexes.push(index);
    }
  }
  return indexes;
}

/**
 * The sources the reply actually cited, as shared `{title, url}` references.
 * Search results nobody cited are DeepSeek's retrieval set, not the reply's
 * sources, so they are not listed. Order and dedupe follow the first citation
 * of each result; a search with no cited result contributes no reference (its
 * `[Web search: ...]` line still renders).
 */
export function searchReferences(fragments) {
  const cited = citedIndexes(fragments);
  if (!cited.length) return [];
  const byIndex = new Map();
  for (const fragment of fragments) {
    if (fragmentType(fragment) !== "SEARCH" || !Array.isArray(fragment.results)) continue;
    for (const result of fragment.results) {
      if (!result || typeof result !== "object") continue;
      if (!Number.isInteger(result.cite_index) || byIndex.has(result.cite_index)) continue;
      const url = typeof result.url === "string" ? result.url.trim() : "";
      if (!isWebUrl(url)) continue;
      const title = [result.title, result.site_name].find((value) => typeof value === "string" && value.trim()) || url;
      byIndex.set(result.cite_index, { title: title.trim(), url });
    }
  }
  const references = [], seen = new Set();
  for (const index of cited) {
    const result = byIndex.get(index);
    if (!result || seen.has(result.url)) continue;
    seen.add(result.url);
    references.push(result);
  }
  return references;
}

/**
 * `[citation:N]` markers point at the search result with cite_index N. The
 * visible UI renders them as a source chip, so use the documented
 * ` ([site_name or title](url))` form; markers without a result are dropped.
 */
export function replaceCitationMarkers(text, markers) {
  return String(text ?? "").replace(/\[citation:(\d+)\]/gi, (_match, digits) => {
    const hit = markers.get(Number(digits));
    return hit ? citationLink(hit.label, hit.url) : "";
  });
}

function citationMarkers(fragments) {
  const markers = new Map();
  for (const fragment of fragments) {
    if (fragmentType(fragment) !== "SEARCH" || !Array.isArray(fragment.results)) continue;
    for (const result of fragment.results) {
      if (!result || !Number.isInteger(result.cite_index) || markers.has(result.cite_index)) continue;
      const url = typeof result.url === "string" ? result.url.trim() : "";
      if (!/^https?:\/\//i.test(url)) continue;
      const label = [result.site_name, result.title]
        .find((value) => typeof value === "string" && value.trim())?.trim() || "source";
      markers.set(result.cite_index, { label, url });
    }
  }
  return markers;
}

function searchLine(fragment) {
  return webSearchLine(queryList(fragment));
}

// Only the file name is user-visible; `signed_path`, ids and tokens are private
// handles that must never reach the copied text.
function fileLines(fragment) {
  const files = Array.isArray(fragment?.files) ? fragment.files
    : Array.isArray(fragment?.file_list) ? fragment.file_list
      : fragment?.file_name ? [fragment] : [];
  return files.map((file) => {
    const name = [file?.file_name, file?.fileName, file?.name]
      .find((value) => typeof value === "string" && value.trim())?.trim() || "";
    const image = file?.is_image === true || /image/i.test(String(file?.content_type || file?.type || ""));
    if (!name) return image ? "[Image]" : "[File]";
    return `[${image ? "Image" : "File"}: ${name}]`;
  });
}

export function fragmentText(fragment, markers) {
  if (typeof fragment === "string") return fragment;
  if (!fragment || typeof fragment !== "object") return "";
  const type = fragmentType(fragment);
  const content = contentOf(fragment);
  if (HIDDEN_TYPES.has(type)) return "";
  if (TEMPLATE_TYPES.has(type)) return content.trim();
  if (type === "SEARCH") return searchLine(fragment);
  if (type === "FILE") return fileLines(fragment).join("\n\n");
  if (["TEXT", "REQUEST", "RESPONSE", "MARKDOWN"].includes(type)) {
    return markers ? replaceCitationMarkers(content, markers) : content;
  }
  if (type === "CODE") {
    const language = fragment.language || fragment.lang || "";
    return content ? `\`\`\`${language}\n${content}\n\`\`\`` : "";
  }
  if (["ATTACHMENT", "IMAGE"].includes(type)) return fileLines(fragment).join("\n\n");
  return type ? `[DeepSeek content: ${type}]` : "[DeepSeek content: unknown]";
}

export { citationMarkers };
