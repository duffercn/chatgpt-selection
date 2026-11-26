// Claude-rich rendering: turns Claude's tool_use / tool_result blocks into
// static Markdown. Nothing here executes embedded code; widget HTML is only
// scanned for text so a copied conversation keeps the meaning of a visual.
import { attachmentPlaceholder, cleanText } from "../core/content.js";
import { HTTP_TEXT_URL, webSearchLine } from "../core/rich.js";

const WEB_SEARCH = "WebSearch";
// Claude.ai's built-in server-side search tool is named in lowercase and
// answers with `knowledge` parts instead of a title/URL text listing.
const CLAUDE_WEB_SEARCH = "web_search";
const SEARCH_NAMES = new Set([WEB_SEARCH, CLAUDE_WEB_SEARCH]);
const VISUALIZE_NAMES = new Set(["mcp__visualize__read_me", "mcp__visualize__show_widget"]);
const SHOW_WIDGET = "mcp__visualize__show_widget";
// Claude's file-handoff tool. Its result lists the files the user can open, so
// the generic tool_use line would be redundant next to `[Files: ...]`.
const PRESENT_FILES = "present_files";
const UNSUPPORTED_BLOCK_TYPES = new Set(["image", "image_asset_pointer", "document", "file", "attachment"]);
// Internal bookkeeping blocks that carry no user-visible content.
const SILENT_BLOCK_TYPES = new Set(["thinking", "reasoning", "token_budget"]);

// Elements whose text is part of the rendered widget (including screen-reader
// headings). Everything else — script, style, attributes, path data — is out.
const WIDGET_TEXT_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "label", "button", "li", "td", "th", "text", "title", "desc"];

function stripHidden(blocks) {
  // A tool_use marked hidden_in_chat and the tool_result answering it are both
  // internal plumbing; neither belongs in a copied transcript.
  const hiddenIds = new Set();
  for (const block of blocks) {
    if (block?.type === "tool_use" && block.hidden_in_chat === true) hiddenIds.add(block.id);
  }
  return blocks.filter((block) => {
    if (!block || typeof block !== "object") return true;
    if (block.hidden_in_chat === true) return false;
    if (block.type === "tool_result" && hiddenIds.has(block.tool_use_id)) return false;
    return true;
  });
}

function resultText(block) {
  const content = block?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part?.type === "text" || typeof part?.text === "string" ? part.text || "" : ""))
    .filter(Boolean)
    .join("\n");
}

// File names offered by a present_files result. Names only: file_path carries
// the user's private directory layout and must never reach the transcript.
function presentedFiles(block) {
  const content = block?.content;
  if (!Array.isArray(content)) return [];
  const names = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || part.type !== "local_resource") continue;
    // A synthetic file_path is only a fallback when the API omits a name; take
    // its last segment so no directory ever leaks.
    const provided = String(part.name || "").trim();
    const fallback = String(part.file_path || "").split("/").pop().trim();
    const name = provided || fallback;
    if (!name || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

// Image parts are listed as one placeholder each, after any text of the result.
// Their file_uuid / preview_url / thumbnail_url are private and never rendered.
function resultImages(block) {
  const content = block?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((part) => part && typeof part === "object" && part.type === "image").length;
}

export function parseSearchSources(block) {
  const lines = resultText(block).split("\n").map((line) => line.trim());
  const sources = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!HTTP_TEXT_URL.test(line)) continue;
    const url = line;
    // Recover the title from the nearest preceding non-empty, non-URL line.
    let title = "";
    for (let j = i - 1; j >= 0; j -= 1) {
      const candidate = lines[j];
      if (!candidate) continue;
      if (HTTP_TEXT_URL.test(candidate)) break;
      title = candidate;
      break;
    }
    if (!title) continue;
    const key = `${title}\n${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ title, url });
  }
  return sources;
}

// `web_search` results carry structured source records rather than text.
function parseKnowledgeSources(block) {
  const content = block?.content;
  if (!Array.isArray(content)) return [];
  const sources = [];
  const seen = new Set();
  for (const part of content) {
    if (!part || typeof part !== "object" || part.type !== "knowledge") continue;
    if (part.is_missing === true) continue;
    const url = String(part.url || "").trim();
    if (!HTTP_TEXT_URL.test(url)) continue;
    const title = cleanText(String(part.title || part.metadata?.site_name || url)).replace(/\n+/g, " ");
    const key = `${title}\n${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ title, url });
  }
  return sources;
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function widgetText(html) {
  const withoutCode = String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*/gi, " ");
  const pattern = new RegExp(`<(${WIDGET_TEXT_TAGS.join("|")})\\b[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`, "gi");
  const seen = new Set();
  const lines = [];
  let match;
  while ((match = pattern.exec(withoutCode)) !== null) {
    const inner = match[2].replace(/<[^>]*>/g, " ");
    const text = cleanText(decodeEntities(inner).replace(/\s+/g, " ")).replace(/\n+/g, " ");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
    // A match consumes its own body, so the shared pattern always advances.
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return lines;
}

function headingName(name) {
  return String(name || "").replaceAll("_", " ");
}

function visualSummary(input = {}) {
  const title = headingName(input.title || "widget").trim();
  const lines = widgetText(input.widget_code || "");
  return [`[Interactive visual: ${title}]`, ...lines].join("\n");
}

function codeBlock(input = {}) {
  const language = input.language || "";
  return `\`\`\`${language}\n${input.content}\n\`\`\``;
}

function renderToolUse(block) {
  const name = block.name || "";
  if (SEARCH_NAMES.has(name)) {
    const query = cleanText(String(block.input?.query || "")).replace(/\n+/g, " ");
    return webSearchLine([query]);
  }
  if (name === SHOW_WIDGET) return visualSummary(block.input);
  // The `[Files: ...]` line from the result replaces this tool_use line.
  if (name === PRESENT_FILES) return "";
  if (block.input?.content) return codeBlock(block.input);
  return `[Tool used: ${name || "unknown"}]`;
}

function renderToolResult(block) {
  const name = block.name || "";
  if (name === VISUALIZE_NAMES || VISUALIZE_NAMES.has(name)) return "";
  if (SEARCH_NAMES.has(name)) {
    if (block.is_error === true) return "[Web search failed]";
    const sources = name === CLAUDE_WEB_SEARCH ? parseKnowledgeSources(block) : parseSearchSources(block);
    if (!sources.length) return "";
    return ["Sources:", ...sources.map(({ title, url }) => `- [${title}](${url})`)].join("\n");
  }
  if (block.is_error === true) return `[Tool error: ${name || "unknown"}]`;
  if (name === PRESENT_FILES) {
    const names = presentedFiles(block);
    return names.length ? `[Files: ${names.join(", ")}]` : "";
  }
  // Other tool results keep no text, but images in them are still worth a mark.
  const images = resultImages(block);
  return images ? Array.from({ length: images }, () => "[Image]").join("\n\n") : "";
}

function renderBlock(block) {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const type = block.type;
  if (type === "text" || type === "input_text" || type === "output_text") return block.text || block.content || "";
  if (SILENT_BLOCK_TYPES.has(type)) return "";
  if (type === "tool_use") return renderToolUse(block);
  if (type === "tool_result") return renderToolResult(block);
  if (UNSUPPORTED_BLOCK_TYPES.has(type)) return attachmentPlaceholder(block);
  if (type) return `[Unsupported content: ${String(type).replaceAll("_", " ")}]`;
  return "";
}

export function renderClaudeBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return cleanText(stripHidden(blocks).map(renderBlock).filter(Boolean).join("\n\n"));
}

export { parseKnowledgeSources, widgetText };
