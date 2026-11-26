// Gemini rich content.
//
// What the user sees in a Gemini reply is not only `candidate[1][0]`:
//
//   - documents / canvases / reports carry the real answer body and its
//     `[cite: N]` markers in `candidate[…][DOCUMENT.body]`;
//   - every `[cite: N]` resolves through the document's citation table;
//   - the reply may show image/audio placeholders such as
//     `http://googleusercontent.com/immersive_entry_chip/0`;
//   - uploaded images are attachments on the user turn.
//
// Everything else (reasoning, thinking steps, tool calls, model flags,
// timestamps) is deliberately left out. An unrecognised field that could hold
// visible content still produces a `[Gemini content: …]` placeholder so that
// nothing disappears silently.

import { citationLink, hostName, isWebUrl } from "../core/rich.js";
import { ATTACHMENT, CANDIDATE, CANDIDATE_META, CITATION, DOCUMENT, USER, USER_PAYLOAD } from "./gemini-layout.js";

/** `[cite: 1]`, `[cite: 2, 3]` — the inline citation marker Gemini writes. */
const CITE_MARKER = /\[cite:\s*([\d,\s]+)\]/g;

/** `http(s)://googleusercontent.com/<chip>/<n>` — an inline UI slot, not a site. */
const CHIP_URL = /https?:\/\/googleusercontent\.com\/([a-z_]+)\/(\d+)/gi;

/**
 * How each inline chip is rendered for the user:
 *
 * - `immersive_entry_chip` — the document/canvas body `[Gemini document: title]`
 *   that the reply links to;
 * - `image_generation_content` — a `[Image: <prompt>]` card. The picture is
 *   served from a signed, expiring `lh3.googleusercontent.com` URL, so only
 *   its prompt is copied (same rule as Doubao's signed media URLs);
 * - `deep_research_confirmation_content` — the Deep Research plan card, rendered
 *   from its `{"56": …}` steps as `[Gemini plan: <title>]`.
 *
 * A chip we do not know still becomes `[Gemini content: <chip name>]`.
 */
const CHIPS = {
  immersive_entry_chip: { label: "document" },
  image_generation_content: { label: "generated image" },
  deep_research_confirmation_content: { label: "deep research confirmation" }
};

/** Key of the Deep Research plan card inside a rendering-AST map. */
const PLAN_KEY = "56";

/** Image-generation card: `[files, [chipUrl, null, prompt], null, [20, prompt, …]]`. */
export const IMAGE_CARD = Object.freeze({
  files: 0, // signed lh3 URL + file name + token (never copied)
  chip: 1, // chip[0] is the inline `image_generation_content` URL, chip[2] the prompt
  // chip[1] was null; [2] was null; [3] is
  // `[20, prompt, …null, true, null, "imagen_default.<style>"]`.
  info: 3
});

/** The prompt shown on an image-generation card ("" when it has none). */
function cardPrompt(card) {
  const chip = card[IMAGE_CARD.chip];
  const fromChip = Array.isArray(chip) ? chip[2] : null;
  if (typeof fromChip === "string" && fromChip.trim()) return fromChip;
  const info = card[IMAGE_CARD.info];
  const fromInfo = Array.isArray(info) ? info[1] : null;
  return typeof fromInfo === "string" ? fromInfo : "";
}

/** `[Image: <prompt>]`, or `[Image]` when the card carries no prompt. */
export function imageMarker(prompt) {
  const text = typeof prompt === "string" ? prompt.replace(/\s+/g, " ").trim() : "";
  return text ? `[Image: ${text}]` : "[Image]";
}

/**
 * Deep Research plan card, in `candidate[12][{"56": …}]`:
 *   [title, [[1, "研究网站", "(1) …"], [2, "分析结果"], [3, "生成报告"]],
 *    estimate, [buttonLabel], [chipUrl, 0], ["修改方案", …]]
 * The steps and their descriptions are what the user read before approving.
 */
export const PLAN_CARD = Object.freeze({
  title: 0,
  steps: 1, // [[number, <step title>, <step detail>?]]
  estimate: 2
});

/** `[Gemini plan: <title>]` + `1. <step> — <detail>` lines. */
export function planMarker(card) {
  const title = typeof card?.[PLAN_CARD.title] === "string" ? card[PLAN_CARD.title].trim() : "";
  const lines = [`[Gemini plan${title ? `: ${title}` : ""}]`];
  for (const step of Array.isArray(card?.[PLAN_CARD.steps]) ? card[PLAN_CARD.steps] : []) {
    if (!Array.isArray(step)) continue;
    const name = typeof step[1] === "string" ? step[1].trim() : "";
    const detail = typeof step[2] === "string" ? step[2].trim() : "";
    if (!name && !detail) continue;
    lines.push(`${Number.isInteger(step[0]) ? `${step[0]}. ` : "- "}${name}${name && detail ? " — " : ""}${detail}`);
  }
  const estimate = typeof card?.[PLAN_CARD.estimate] === "string" ? card[PLAN_CARD.estimate].trim() : "";
  if (estimate) lines.push(estimate);
  return lines.join("\n");
}

/** Plan cards inside a rendering-AST value (`{"56": card}`). */
function planCardsIn(value) {
  const cards = [];
  const visit = (node) => {
    if (!Array.isArray(node)) return;
    for (const item of node) {
      if (item && typeof item === "object" && !Array.isArray(item) && Array.isArray(item[PLAN_KEY])) cards.push(item[PLAN_KEY]);
      else visit(item);
    }
  };
  visit(value);
  return cards;
}

const isNothing = (value) => value === null || value === undefined;
const isEmptyArray = (value) => Array.isArray(value) && value.length === 0;

/** True when `value` is `null`, `""`, `[]` or an array holding only those. */
export function isBlank(value) {
  if (isNothing(value)) return true;
  if (typeof value === "string") return value.trim() === "";
  if (isEmptyArray(value)) return true;
  if (Array.isArray(value)) return value.every((item) => isBlank(item));
  return false;
}

/**
 * True for a value that is only flags/enums: booleans, numbers, or arrays of
 * them (`[2]`, `[false]`, `[null, null, 8]`). Such a field cannot be visible
 * prose, so it does not need a placeholder.
 */
function isFlagsOnly(value) {
  if (typeof value === "boolean" || typeof value === "number") return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => typeof item === "boolean" || typeof item === "number" || isNothing(item) || isFlagsOnly(item));
}

function citeNumbers(numbers) {
  return numbers
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((number) => Number.isInteger(number) && number > 0);
}

/**
 * Resolves the `[cite: N]` markers of one reply text.
 *
 * `sources` maps a citation number to `{title, url}`. A marker resolves to a
 * citation link per source; a number without a known source still keeps a
 * marker so the reader sees that something was cited.
 */
export function resolveCitations(text, sources) {
  if (typeof text !== "string" || !text) return "";
  return text
    // Gemini writes " [cite: N]" with a leading space, and our citation link
    // starts with one too, so the marker's own padding is dropped.
    .replace(/\s*(\[cite:\s*[\d,\s]+\])/g, "$1")
    .replace(CITE_MARKER, (_match, numbers) => {
      const resolved = citeNumbers(numbers).map((number) => {
        const source = sources.get(number);
        if (!source) return "(citation)";
        // `citationLink` already starts with a space.
        return citationLink(source.title || hostName(source.url) || "source", source.url.trim());
      });
      // Unresolved markers carry no leading space of their own.
      return resolved.length ? resolved.map((part) => (part.startsWith("(") ? ` ${part}` : part)).join("") : " (citation)";
    });
}

/** Citation number → `{title, url}` from a document's citation table. */
export function documentSources(document) {
  const sources = new Map();
  for (const table of document?.[DOCUMENT.citations] || []) {
    for (const entry of table?.[DOCUMENT.citationIndex] || []) {
      for (const source of entry?.[CITATION.groups] || []) {
        const detail = source?.[CITATION.source]?.[CITATION.detail];
        const number = source?.[CITATION.source]?.[CITATION.number];
        const url = detail?.[CITATION.url];
        if (!Number.isInteger(number) || !isWebUrl(url)) continue;
        const title = typeof detail?.[CITATION.title] === "string" ? detail[CITATION.title].trim() : "";
        if (!sources.has(number)) sources.set(number, { title, url: url.trim() });
      }
    }
  }
  return sources;
}

/** Replaces inline `googleusercontent.com/<chip>/<n>` slots.
 *
 * `context` is `{ documents, images }`: documents are matched to
 * `immersive_entry_chip` slots in order, image prompts to
 * `image_generation_content` slots in order.
 */
function chipPlaceholders(text, context = {}) {
  const documents = context.documents || [];
  const images = context.images || [];
  const plans = context.plans || [];
  let documentIndex = 0, imageIndex = 0, planIndex = 0;
  return text.replace(CHIP_URL, (_match, chip) => {
    if (chip === "immersive_entry_chip" && documents[documentIndex]) return documentMarker(documents[documentIndex++]);
    if (chip === "image_generation_content") return imageMarker(images[imageIndex++]);
    if (chip === "deep_research_confirmation_content" && plans[planIndex]) return planMarker(plans[planIndex++]);
    const known = CHIPS[chip];
    return `[Gemini content: ${known ? known.label : chip.replaceAll("_", " ")}]`;
  });
}

/**
 * Image-generation cards in one value: `[[chipUrl, null, prompt, [20, …]]]` or
 * the card group `[[[card, …]]]` seen in `data[3]` and `candidate[…][7]`.
 */
function imageCardsIn(value) {
  const cards = [];
  const visit = (node) => {
    if (!Array.isArray(node)) return;
    const chip = node[IMAGE_CARD.chip]?.[0];
    if (typeof chip === "string" && /\/image_generation_content\//.test(chip)) {
      cards.push(node);
      return;
    }
    node.forEach(visit);
  };
  visit(value);
  return cards;
}

/**
 * The text a document answer actually shows the user. `body` is the full
 * report; a citation-free body is returned as is, a cited one is resolved and
 * followed by the sources it cited.
 */
export function renderDocumentBody(body, sources) {
  if (typeof body !== "string" || !body.trim()) return "";
  const text = resolveCitations(chipPlaceholders(body), sources).trim();
  if (!text) return "";
  return text;
}

function documentTitle(document) {
  const title = document?.[DOCUMENT.title];
  if (typeof title === "string" && title.trim()) return title.trim();
  const fileName = document?.[DOCUMENT.fileName];
  return typeof fileName === "string" && fileName.trim() ? fileName.trim().replace(/^c_[a-f0-9]+_/, "") : "";
}

/** `[Gemini document: <title>]` for a canvas/report the reply links to. */
export function documentMarker(document) {
  const title = documentTitle(document);
  return title ? `[Gemini document: ${title}]` : "[Gemini document]";
}

/**
 * Attachments of a user turn, as `format.js` reads them: `{name, type}` where
 * `type` is the MIME type. `format.js` renders `[Attachment: <name>]` for a
 * named file and `[Image]` for an unnamed image.
 */
export function userAttachments(user) {
  const groups = user?.[USER.payload]?.[USER_PAYLOAD.attachments];
  const items = [];
  const seen = new Set();
  for (const group of groups || []) {
    // A group is `[null, null, null, [[file, …]], [[file, …]], …]`: the files
    // are listed once per slot, so only slot ATTACHMENT.group is read.
    const files = Array.isArray(group) ? group[ATTACHMENT.group] : null;
    for (const file of Array.isArray(files) ? files : []) {
      if (!Array.isArray(file)) continue;
      const name = typeof file[ATTACHMENT.name] === "string" ? file[ATTACHMENT.name].trim() : "";
      const type = typeof file[ATTACHMENT.mime] === "string" ? file[ATTACHMENT.mime] : "";
      if (!name && !type) continue;
      const key = `${name}|${type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ name, type });
    }
  }
  return items;
}

/**
 * True for the reasoning block: `[["<text>"], [[…]]]` — an array whose first
 * item is text (or a list of text) followed by its own step list. Reply prose
 * is always a plain string in `candidate[1]`, so an array here is never the
 * visible answer. A lone string array (`["text"]`) is *not* reasoning: it is a
 * field we do not recognise and must keep as a placeholder.
 */
function isReasoningBlock(value) {
  if (!Array.isArray(value) || value.length < 2) return false;
  const [primary, secondary] = value;
  const isTextNode = (node) => typeof node === "string" || (Array.isArray(node) && node.length > 0 && node.some((item) => typeof item === "string"));
  return isTextNode(primary) && Array.isArray(secondary);
}

/** True for a document/canvas entry: an array with a title and a body string. */
export function isDocument(value) {
  return Array.isArray(value)
    && typeof value[DOCUMENT.title] === "string"
    && [DOCUMENT.body, ...DOCUMENT.duplicateBody].some((index) => typeof value[index] === "string" && value[index].length > 0);
}

/**
 * The documents a candidate field holds. Gemini lists them in a group array
 * (`[[document, …]]`) next to `text`; the group is the only wrapper level.
 */
function documentsIn(value) {
  if (!Array.isArray(value)) return [];
  if (isDocument(value)) return [value];
  return value.filter(isDocument);
}

const CANDIDATE_KNOWN = new Set([
  CANDIDATE.id,
  CANDIDATE.text,
  CANDIDATE_META.mode,
  ...CANDIDATE_META.booleanFlags,
  CANDIDATE_META.language,
  CANDIDATE_META.rendering,
  CANDIDATE_META.numericIndex
]);

function visiblePlaceholder(index, value) {
  if (isFlagsOnly(value)) return "";
  return `[Gemini content: answer field ${index}]`;
}

/**
 * Renders the selected candidate.
 *
 * `{ text, placeholders }`: the reply Markdown (documents first, then the
 * candidate text with citations resolved and UI chips replaced) and any
 * `[Gemini content: …]` placeholders emitted for fields we do not recognise.
 */
export function renderCandidate(candidate) {
  const placeholders = [];
  if (!Array.isArray(candidate)) return { text: "", placeholders: ["[Gemini content: reply]"] };

  const sources = new Map();
  const documents = [];
  const images = [];
  const plans = [];
  for (const value of candidate) {
    for (const document of documentsIn(value)) {
      documents.push(document);
      for (const [number, source] of documentSources(document)) if (!sources.has(number)) sources.set(number, source);
    }
    for (const card of imageCardsIn(value)) images.push(cardPrompt(card));
    for (const plan of planCardsIn(value)) plans.push(plan);
  }

  // The reply text comes first (it holds the document chip), then each
  // document body. A text-only chip is already represented by the marker, so
  // it is not repeated.
  const blocks = [];
  const reply = candidate[CANDIDATE.text]?.[0];
  if (typeof reply === "string" && reply.trim()) {
    const rendered = resolveCitations(chipPlaceholders(reply, { documents, images, plans }), sources).trim();
    const markers = [...documents.map(documentMarker), ...images.map(imageMarker), ...plans.map(planMarker)];
    if (rendered && !markers.includes(rendered)) blocks.push(rendered);
  }
  for (const document of documents) {
    blocks.push(renderDocumentBody(document[DOCUMENT.body], sources) || "[Gemini content: document body]");
  }

  for (let index = CANDIDATE.text + 1; index < candidate.length; index++) {
    if (CANDIDATE_KNOWN.has(index)) continue;
    const value = candidate[index];
    if (isBlank(value)) continue;
    if (isReasoningBlock(value)) continue; // thinking: never copied
    if (documentsIn(value).length || imageCardsIn(value).length || planCardsIn(value).length) continue; // already rendered above
    const placeholder = visiblePlaceholder(index, value);
    if (placeholder) placeholders.push(placeholder);
  }

  const text = [...blocks, ...placeholders].filter(Boolean).join("\n\n");
  return { text, placeholders };
}

/**
 * Visible markers for values outside the candidate: the reply's tool/step
 * fields (`response[4]`, `response[5]`) and the history tail (`data[3]`).
 *
 * Only image-generation cards are understood there; anything else is turned
 * into a placeholder by the caller, never dropped.
 */
export function extrasMarkers(values) {
  const markers = [];
  for (const value of values) {
    for (const card of imageCardsIn(value)) markers.push(imageMarker(cardPrompt(card)));
  }
  return markers;
}

/** True when an extras value holds something we cannot classify as metadata. */
export function hasUnhandledExtras(value) {
  return !isBlank(value) && imageCardsIn(value).length === 0;
}
