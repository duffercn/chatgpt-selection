// Shared helpers for the platform rich-content modules (chatgpt-refs,
// claude-rich, deepseek-rich, doubao-rich, grok-rich).
//
// Everything here is a pure string/array transformation: no DOM, no eval, no
// network. A helper is only shared when every caller produces the same bytes;
// where a site deliberately renders something differently (Claude's inline
// `Sources:` list, Doubao's captioned media lines) the site keeps its own code.

/**
 * Strict URL test for text that must be a whole `http(s)` URL with no
 * whitespace (Claude's search-result lines, Grok's card links).
 */
export const HTTP_TEXT_URL = /^https?:\/\/\S+$/i;

/**
 * True for a trimmed `http(s)://` prefix (DeepSeek and Doubao filter on the
 * prefix only and then use the trimmed URL).
 */
export function isWebUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

/** Hostname without a leading "www."; "" when the URL cannot be parsed. */
export function hostName(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ""); } catch { return ""; }
}

/**
 * Removes the given tracking/analytics query parameters from a URL, keeping
 * every other query parameter, the fragment, and the original string when the
 * URL cannot be parsed.
 *
 * `bare` is dropped as a literal `key=value` pair instead of going through
 * `URL`, which re-encodes a URL that was written by hand (ChatGPT's `alt`
 * links). Sites whose URLs come from the API use the default.
 */
export function stripQueryParams(url, names, { bare = false } = {}) {
  if (bare) {
    for (const pair of names) {
      const escaped = pair.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      url = url.replace(new RegExp(`([?&])${escaped}(&|$)`, "g"), (_, separator, tail) => (tail ? separator : ""));
    }
    return url.replace(/[?&]$/, "");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const key of names) parsed.searchParams.delete(key);
  return parsed.href.replace(/\?$/, "");
}

/** ` ([label](url))`, the inline citation every adapter appends to its text. */
export function citationLink(label, url) {
  return ` ([${label}](${url}))`;
}

/** `[Web search: q1 · q2]`, `[Web search: q]`, or `[Web search]` when there is no query. */
export function webSearchLine(queries) {
  const cleaned = (Array.isArray(queries) ? queries : [])
    .map((query) => (typeof query === "string" ? query.trim() : ""))
    .filter(Boolean);
  return cleaned.length ? `[Web search: ${cleaned.join(" · ")}]` : "[Web search]";
}

/**
 * Adds `{title, url}` references in order, skipping non-http(s) entries and
 * URLs already present. `key` defaults to the raw URL; Grok compares
 * case-insensitively.
 */
export function addWebReference(list, seen, item, { key = (url) => url } = {}) {
  const url = typeof item?.url === "string" ? item.url.trim() : "";
  if (!isWebUrl(url)) return false;
  const id = key(url);
  if (seen.has(id)) return false;
  seen.add(id);
  list.push({ title: item.title, url });
  return true;
}
