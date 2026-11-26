// Grok-rich rendering: turns Grok's inline card tags into static Markdown and
// lists, as references, only the sources a reply actually cited. Nothing here
// executes embedded markup; a card tag is replaced by plain text so a copied
// reply never leaks private tag syntax.
import { cleanText } from "../core/content.js";
import { HTTP_TEXT_URL, citationLink, hostName } from "../core/rich.js";

// An opening tag: attributes end at `>` (an attribute value may hold a URL's
// slash), so `\b` is safe here because the tag name always ends in a word char.
const TAG_OPEN = /<grok:render\b([^<>]*)>/gi;
const TAG_CLOSE = "</grok:render>";
const ARGUMENT_BLOCK = /<argument\b[^>]*>[\s\S]*?<\/argument>\s*/gi;
// Attribute names are plain identifiers; values may be single- or double-quoted.
// A source string, not a pattern: `matchAll` would otherwise continue from a
// previous call's lastIndex and silently skip attributes.
const ATTRIBUTE_SOURCE = "([A-Za-z_][\\w-]*)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')";
// Any tag-shaped residue is dropped so no private tag syntax can reach the
// transcript, even for a tag form this module has not seen yet.
const RESIDUE_TAG = /<\/?\s*(?:grok|argument|xai)\b[^<>]*(?:>|$)|\bcard_id\s*=/gi;
const X_STATUS = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/i;

function parseAttributes(source) {
  const attributes = {};
  for (const match of String(source || "").matchAll(new RegExp(ATTRIBUTE_SOURCE, "g"))) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return attributes;
}

/** Card attachments arrive as an array of JSON strings; unusable entries are ignored. */
export function parseCards(cardAttachmentsJson) {
  if (!Array.isArray(cardAttachmentsJson)) return [];
  return cardAttachmentsJson.map((item) => {
    if (typeof item === "string") {
      try { return JSON.parse(item); } catch { return null; }
    }
    return item && typeof item === "object" ? item : null;
  }).filter((card) => card && typeof card.id === "string" && card.id);
}

function httpUrl(value) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return HTTP_TEXT_URL.test(text) ? text : "";
}

function xStatus(url) {
  const match = X_STATUS.exec(url || "");
  return match ? { username: match[1], postId: match[2] } : null;
}

function isCitationCard(card, attributes) {
  return /citation/.test(String(card?.type || attributes?.type || "").toLowerCase()) || card?.cardType === "citation_card";
}

function truncate(text, limit = 80) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/** `@username: <first 80 characters of the post>`; the title for an X-post source. */
export function xPostTitle(post) {
  const username = typeof post?.username === "string" ? post.username.trim() : "";
  const body = truncate(post?.text || post?.textMarkdown);
  if (body) return username ? `@${username}: ${body}` : body;
  return username ? `@${username}` : "X post";
}

function imageCardText(card) {
  const image = card?.image && typeof card.image === "object" ? card.image : {};
  const link = httpUrl(image.link) || httpUrl(image.original) || httpUrl(image.thumbnail);
  const title = truncate(image.title || image.source || "", 120);
  if (link) return [`[Image: ${title || hostName(link)}](${link})`];
  return title ? [`[Image: ${title}]`] : ["[Image]"];
}

/**
 * Replaces one card tag. Citation cards become ` ([domain](url))`, X-post
 * citations become a post link, image cards become a static image line. A card
 * type this module does not understand becomes a visible placeholder: dropping
 * it would silently lose content a reader saw. A citation tag with no card, or
 * with a non-http(s) URL, still renders nothing because there is no content to
 * keep beyond the tag itself.
 */
function renderCardTag(attributes, cards) {
  const id = attributes.card_id || "";
  const card = cards.find((item) => item.id === id);
  const type = String(card?.type || attributes.type || "").toLowerCase();
  const url = httpUrl(card?.url);
  if (isCitationCard(card, attributes)) {
    if (!url) return "";
    const post = xStatus(url);
    if (post) return citationLink(`@${post.username}`, url);
    const domain = hostName(url);
    return citationLink(domain || "source", url);
  }
  if (card?.cardType === "image_card" || /image/.test(type)) return imageCardText(card).join(" ");
  return unknownCardPlaceholder(card, attributes);
}

/**
 * `[Grok content: <card type>]` for a card the renderer cannot turn into text.
 * The card's own type wins over the tag attribute's, and an attribute-only tag
 * still names what it was.
 */
function unknownCardPlaceholder(card, attributes) {
  const name = [card?.cardType, card?.type, attributes?.card_type, attributes?.type]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean);
  return `[Grok content: ${name || "unknown"}]`;
}

/**
 * Rewrites a Grok message body: inline card tags become links or are removed.
 * Each tag pair (and its `<argument>` children) is replaced by the card's
 * static text, so the prose around it survives; an unclosed tag loses only its
 * own markup, which is what a truncated reply contains.
 */
export function renderGrokText(message, cards) {
  const text = String(message ?? "");
  if (!text || !/grok|argument/i.test(text)) return text;
  const output = [];
  let position = 0;
  for (const match of text.matchAll(TAG_OPEN)) {
    output.push(text.slice(position, match.index));
    const bodyStart = match.index + match[0].length;
    const close = text.indexOf(TAG_CLOSE, bodyStart);
    const nextOpen = text.slice(bodyStart).search(TAG_OPEN);
    if (close < 0) {
      // Truncated reply: drop the unfinished tag and everything after it.
      return redact(output.join(""));
    }
    if (nextOpen >= 0 && bodyStart + nextOpen < close) {
      // A new tag opened before this one closed; the broken one carries nothing.
      position = bodyStart;
      continue;
    }
    output.push(renderCardTag(parseAttributes(match[1]), cards));
    position = close + TAG_CLOSE.length;
  }
  output.push(text.slice(position));
  return redact(output.join(""));
}

/** Last-resort redaction so no private tag syntax can reach the transcript. */
function redact(text) {
  return text.replace(ARGUMENT_BLOCK, "").replace(RESIDUE_TAG, "");
}

/** Web search title per URL; a URL repeated keeps its first usable title. */
export function searchReferences(results) {
  const titles = new Map();
  if (!Array.isArray(results)) return titles;
  for (const item of results) {
    const url = httpUrl(item?.url);
    if (!url) continue;
    const title = typeof item?.title === "string" ? item.title.replace(/\s+/g, " ").trim() : "";
    if (!titles.get(url) && title) titles.set(url, title);
  }
  return titles;
}

/** X-post title and canonical URL per post url (`x.com/<user>/status/<id>`). */
export function xPostReferences(posts) {
  const titles = new Map();
  if (!Array.isArray(posts)) return titles;
  for (const post of posts) {
    const username = typeof post?.username === "string" ? post.username.trim() : "";
    const postId = post?.postId === undefined || post?.postId === null ? "" : String(post.postId);
    if (!username || !/^[A-Za-z0-9_]+$/.test(username) || !/^\d+$/.test(postId)) continue;
    const url = `https://x.com/${username}/status/${postId}`;
    if (!titles.has(url)) titles.set(url, xPostTitle(post));
  }
  return titles;
}

/**
 * Card ids of the citation tags that are actually rendered, in citation order.
 * It walks the body exactly as `renderGrokText` does, so a tag swallowed by a
 * broken neighbour or cut off by a truncated reply is not counted as cited: the
 * inline text and the reference list always agree.
 */
export function citedCardIds(message) {
  const text = typeof message === "string" ? message : "";
  if (!text || !/grok/i.test(text)) return [];
  const ids = [];
  let position = 0;
  for (const match of text.matchAll(TAG_OPEN)) {
    if (match.index < position) continue;
    const bodyStart = match.index + match[0].length;
    const close = text.indexOf(TAG_CLOSE, bodyStart);
    if (close < 0) return ids;
    const nextOpen = text.slice(bodyStart).search(TAG_OPEN);
    if (nextOpen >= 0 && bodyStart + nextOpen < close) {
      position = bodyStart;
      continue;
    }
    const attributes = parseAttributes(match[1]);
    if (/citation/i.test(attributes.type || attributes.card_type || "") && attributes.card_id) {
      ids.push(attributes.card_id);
    }
    position = close + TAG_CLOSE.length;
  }
  return ids;
}

/**
 * Ordered, URL-deduplicated references for one reply: only the sources whose
 * citation cards the reply actually cites. Uncited search results and X posts
 * are Grok's retrieval set, not the reply's sources, so they are not listed.
 */
export function grokReferences(node) {
  const cited = citedCardIds(node?.message);
  if (!cited.length) return [];
  const cards = new Map(parseCards(node?.cardAttachmentsJson).map((card) => [card.id, card]));
  const searchTitles = searchReferences(node?.webSearchResults);
  const xPostTitles = xPostReferences(node?.xposts);
  const references = [], seen = new Set();
  for (const id of cited) {
    const card = cards.get(id);
    const url = httpUrl(card?.url);
    if (!url || !isCitationCard(card)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ title: referenceTitle(url, searchTitles, xPostTitles), url });
  }
  return references;
}

/**
 * Search-result title, then X-post title (for an x.com status url), then the
 * bare domain.
 */
function referenceTitle(url, searchTitles, xPostTitles) {
  const search = searchTitles.get(url);
  if (search) return search;
  const post = xStatus(url);
  if (post) {
    const postTitle = xPostTitles.get(`https://x.com/${post.username}/status/${post.postId}`);
    if (postTitle) return postTitle;
  }
  return hostName(url) || url;
}

/** Everything a Grok reply contributes to the transcript. */
export function renderGrokMessage(node) {
  const cards = parseCards(node?.cardAttachmentsJson);
  return { text: cleanText(renderGrokText(node?.message, cards)), references: grokReferences(node) };
}
