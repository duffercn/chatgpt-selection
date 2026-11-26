import { CopyError, ErrorCode, responseError } from "../core/errors.js";
import { summarizeDoubaoResponse } from "./doubao-shape.js";
import { citedReferences, legacyCitations, proseCitations, renderLegacyRichText, renderRichText, searchNoticeLine } from "./doubao-rich.js";

const invalid = (text) => new CopyError(ErrorCode.INVALID_RESPONSE, `Doubao: ${text}`);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const emptyObject = (value) => object(value) && Object.keys(value).length === 0;
const emptyArray = (value) => Array.isArray(value) && value.length === 0;

export function parseDoubaoConversation(data, conversationId) {
  const body = data?.downlink_body?.pull_singe_chain_downlink_body;
  if (data?.cmd !== 3100 || data?.status_code !== 0 || !object(body)) throw invalid("The history API did not return a successful message chain.");
  if (body.has_more !== false || body.msg_cursor !== "1" || !emptyObject(body.regen_messages)) throw invalid("History is paginated or contains unverified regeneration branches.");
  if (!Array.isArray(body.messages) || !body.messages.length) throw invalid("The history response is empty.");
  if (body.messages.length % 2 !== 0) throw invalid("The final reply is missing or unfinished.");
  const ids = new Set(), indices = new Set(), sections = new Set();
  const records = body.messages.map((message) => {
    if (message?.conversation_id !== conversationId || typeof message.message_id !== "string" || !message.message_id || ids.has(message.message_id)) throw invalid("Message identifiers do not form one unique conversation.");
    ids.add(message.message_id);
    if (typeof message.index_in_conv !== "string" || !/^[1-9]\d*$/.test(message.index_in_conv) || indices.has(message.index_in_conv)) throw invalid("Message order is missing or ambiguous.");
    indices.add(message.index_in_conv);
    // content_status 120 is a completed legacy reply; 0 is the only other value
    // observed. Both were verified against finished conversations.
    if (![1, 2].includes(message.user_type) || message.status !== 0 || ![0, 120].includes(message.content_status) || ![9999, 1].includes(message.content_type) || message.ext?.is_finish !== "1") throw invalid("A message is unfinished or uses an unverified content format.");
    if (message.content_type === 9999) {
      // The flag is present on most messages; when it is, it must be "1".
      if (!blockMirrorContent(message.content, message.content_block) || (message.ext?.use_content_block !== undefined && message.ext?.use_content_block !== "1")) throw invalid("A message is unfinished or uses an unverified content format.");
    } else if (message.ext?.use_content_block !== undefined) throw invalid("A message is unfinished or uses an unverified content format.");
    if (!emptyArray(message.regen_msg_list) || typeof message.section_id !== "string" || !message.section_id) throw invalid("The active section or regeneration history is ambiguous.");
    sections.add(message.section_id);
    const parsed = parseContentBlocks(message);
    return { message, index: BigInt(message.index_in_conv), text: parsed.text, references: parsed.references };
  }).sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 : 0);
  // The API reports the whole active chain (`has_more` false); it may begin at an
  // index above 1 when earlier turns predate the returned window. A single
  // section and a leading user message are what make the chain unambiguous.
  if (sections.size !== 1) throw invalid("The beginning or active section of the conversation is incomplete.");
  for (let index = 0; index < records.length; index++) {
    const current = records[index].message, previous = records[index - 1]?.message;
    if (current.user_type !== (index % 2 === 0 ? 1 : 2) || (current.user_type === 2 && current.bot_reply_message_id !== previous?.message_id)) throw invalid("The current reply chain is ambiguous.");
  }
  return { platform: "doubao", id: conversationId, title: "", messages: records.map(({ message, text, references }) => ({ id: message.message_id, role: message.user_type === 1 ? "user" : "assistant", text, references })) };
}

/**
 * A block message's `content` is normally empty; one observed reply repeated a
 * reduced copy of its blocks there. Accept that only when the block types line
 * up exactly, so the field can never carry content the blocks do not.
 */
function blockMirrorContent(content, blocks) {
  if (content === "") return true;
  if (typeof content !== "string" || !Array.isArray(blocks)) return false;
  let mirror;
  try {
    mirror = JSON.parse(content);
  } catch {
    return false;
  }
  if (!Array.isArray(mirror) || mirror.length !== blocks.length) return false;
  return mirror.every((item, position) => object(item) && item.block_type === blocks[position]?.block_type);
}

/**
 * Two message formats were verified. Newer messages (content_type 9999) carry
 * content blocks: prose (10000), search sources (10025), a quoted earlier reply
 * (10056), a document preview (10030), the AI disclaimer (10053) and suggested
 * follow-up questions (2002), rendered or skipped by block_type in array order.
 * Legacy messages (content_type 1) put `{text, search_references}` in a JSON
 * string and their citations in `ext.meta_info`. Anything else is rejected
 * rather than silently dropped.
 */
function parseContentBlocks(message) {
  return message.content_type === 1 ? parseLegacyMessage(message) : parseBlockMessage(message);
}

function parseBlockMessage(message) {
  const blocks = message?.content_block;
  if (!Array.isArray(blocks) || !blocks.length) throw invalid("A message has no content blocks.");
  const allowed = [10000, 10025, 10030, 10053, 10056, 2002];
  if (blocks.some((block) => !allowed.includes(block?.block_type))) throw invalid("The message contains unverified rich content.");
  if (blocks.filter((block) => block?.block_type === 10025).length > 1) throw invalid("Multiple search reference blocks require additional verification.");
  if (blocks.filter((block) => block?.block_type === 10056).length > 1) throw invalid("Multiple quoted references require additional verification.");
  // A reply may be only prose, prose around a document preview, or a bare
  // document preview; the rendered text must still carry something.
  if (!blocks.some((block) => block?.block_type === 10000) && !blocks.some((block) => block?.block_type === 10030)) throw invalid("A message has no copyable text.");

  const parts = [], cards = [], citations = [];
  for (const block of blocks) {
    checkBlockEnvelope(block);
    if (block.block_type === 10000) {
      parts.push({ text: renderRichText(proseText(block), block.meta_info) });
      citations.push(...proseCitations(block.meta_info));
    } else if (block.block_type === 10025) {
      parts.push({ notice: searchNoticeLine(block.content?.search_query_result_block?.queries) });
      cards.push(...parseSearchCards(block));
    } else if (block.block_type === 10056) {
      parts.push({ text: quotedReply(block) });
    } else if (block.block_type === 10030) {
      parts.push({ text: documentPreview(block) });
    } else if (block.block_type === 10053) {
      checkDisclaimer(block);
    } else {
      checkSuggestions(block);
    }
  }
  // Blocks render in array order, separated by a blank line. The search queries
  // line leads the reply, as it did for the single-block layout, and a quote
  // block already brings its own trailing blank line.
  const notice = parts.map((part) => part.notice ?? "").join("");
  const body = parts.map((part) => part.text).filter(Boolean)
    .reduce((text, part) => text && !text.endsWith("\n\n") ? `${text}\n\n${part}` : text + part, "");
  // Only the sources the reply cites inline are listed; a search block on its
  // own is a retrieval set, and its `[Web search: ...]` line still renders.
  return { text: notice + body.replace(/^\n\n/, ""), references: citedReferences(citations, cards) };
}

/** Legacy `content_type: 1` message: JSON content plus citations in ext.meta_info. */
function parseLegacyMessage(message) {
  const blocks = message?.content_block;
  if (blocks !== undefined && !emptyArray(blocks)) throw invalid("The message contains unverified rich content.");
  if (typeof message.content !== "string" || !message.content) throw invalid("The message contains unverified visible content.");
  let content;
  try {
    content = JSON.parse(message.content);
  } catch {
    throw invalid("The message contains unverified visible content.");
  }
  if (!object(content) || Object.keys(content).some((key) => !["text", "search_references"].includes(key))) throw invalid("The message contains unverified visible content.");
  if (typeof content.text !== "string" || !content.text.trim()) throw invalid("The message contains unverified visible content.");
  const entries = legacyMetaInfo(message.ext?.meta_info);
  // A legacy reply lists the same sources twice: as search cards and as inline
  // citations. Only the cited ones are sources; the cards just carry titles.
  const references = citedReferences(legacyCitations(entries), searchCards(content.search_references));
  return { text: renderLegacyRichText(content.text, entries), references };
}

function legacyMetaInfo(value) {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string") throw invalid("An unknown or unfinished rich block cannot be copied safely.");
  let entries;
  try {
    entries = JSON.parse(value);
  } catch {
    throw invalid("An unknown or unfinished rich block cannot be copied safely.");
  }
  if (!Array.isArray(entries)) throw invalid("An unknown or unfinished rich block cannot be copied safely.");
  return entries;
}

/** Search cards from a legacy payload, as `{title, url}` title sources. */
function searchCards(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw invalid("The search reference block is empty.");
  const cards = [];
  for (const result of list) {
    const card = result?.text_card;
    if (!object(card)) continue;
    const title = typeof card.title === "string" ? card.title.trim() : "";
    const url = typeof card.url === "string" ? card.url.trim() : "";
    if (!title || !/^https?:\/\//.test(url)) continue;
    cards.push({ title, url });
  }
  return cards;
}

/** Every verified block repeats the same empty envelope around its content. */
function checkBlockEnvelope(block) {
  if (block.is_finish !== true || !Array.isArray(block.meta_info) || !emptyObject(block.extra_info) || !emptyArray(block.append_fields)) throw invalid("An unknown or unfinished rich block cannot be copied safely.");
  if (!object(block.content) || block.content.pc_event_block !== "") throw invalid("An unknown search reference block cannot be copied safely.");
}

function proseText(block) {
  const content = block.content, text = content?.text_block;
  if (Object.keys(content).some((key) => !["text_block", "pc_event_block"].includes(key))) throw invalid("An unknown search reference block cannot be copied safely.");
  if (!object(text) || Object.keys(text).some((key) => !["text", "icon_url", "icon_url_dark", "summary"].includes(key)) || text.icon_url !== "" || text.icon_url_dark !== "" || text.summary !== "" || typeof text.text !== "string" || !text.text.trim()) throw invalid("The message contains unverified visible content.");
  return text.text;
}

/** 10056 on a user message: the part of an earlier reply the user quoted. */
function quotedReply(block) {
  if (Object.keys(block.content).some((key) => !["reference_block", "pc_event_block"].includes(key))) throw invalid("An unknown or unfinished rich block cannot be copied safely.");
  const reference = block.content.reference_block;
  if (!object(reference) || Object.keys(reference).some((key) => !["type", "text"].includes(key)) || reference.type !== 6) throw invalid("The message contains unverified rich content.");
  const quote = reference.text;
  if (!object(quote) || Object.keys(quote).some((key) => !["text", "message_id", "sub_index"].includes(key)) || typeof quote.message_id !== "string" || quote.sub_index !== 0 || typeof quote.text !== "string" || !quote.text.trim()) throw invalid("The message contains unverified rich content.");
  const lines = quote.text.replace(/\r\n?/g, "\n").trim().split("\n").map((line) => line ? `> ${line}` : ">");
  // The quote block already ends with a blank line separating it from the prose.
  return `${lines.join("\n")}\n\n`;
}

/** 10030: a Doubao document, shown by its title and the API's short preview. */
function documentPreview(block) {
  if (Object.keys(block.content).some((key) => !["artifact_block", "pc_event_block"].includes(key))) throw invalid("An unknown or unfinished rich block cannot be copied safely.");
  const artifact = block.content.artifact_block;
  if (!object(artifact) || Object.keys(artifact).some((key) => !["resource_id", "artifact_meta_id", "artifact_version_id", "conversation_id", "version", "resource_version", "artifact_topic", "title", "brief", "source_type", "resource_type", "status", "resource_content_type"].includes(key))) throw invalid("The document preview uses an unverified format.");
  if (artifact.resource_type !== 10 || artifact.source_type !== 1 || artifact.status !== 2 || artifact.resource_content_type !== "type/ddxml") throw invalid("The document preview uses an unverified format.");
  const title = typeof artifact.title === "string" ? artifact.title.trim() : "", brief = typeof artifact.brief === "string" ? artifact.brief.trim() : "";
  if (!title || !brief) throw invalid("The document preview uses an unverified format.");
  return `[Doubao document: ${title}]\n\n${brief}\n\n(Preview only. Open the document in Doubao for the full text.)`;
}

/** 10053 type 1 is the fixed AI disclaimer; any other tip is unverified. */
function checkDisclaimer(block) {
  if (Object.keys(block.content).some((key) => !["tips_block", "pc_event_block"].includes(key))) throw invalid("The message contains unverified rich content.");
  const tips = block.content.tips_block;
  if (!object(tips) || Object.keys(tips).some((key) => !["type", "text"].includes(key)) || tips.type !== 1 || typeof tips.text !== "string") throw invalid("The message contains unverified rich content.");
}

/** 2002 suggested follow-up questions are UI affordances, not conversation text. */
function checkSuggestions(block) {
  if (Object.keys(block.content).some((key) => !["suggest_block", "pc_event_block"].includes(key))) throw invalid("The message contains unverified rich content.");
  const suggest = block.content.suggest_block;
  if (!object(suggest) || Object.keys(suggest).some((key) => !["suggest", "suggestions"].includes(key)) || typeof suggest.suggest !== "string" || !Array.isArray(suggest.suggestions) || suggest.suggestions.some((item) => typeof item !== "string")) throw invalid("The message contains unverified rich content.");
}

/** Titles from a 10025 search block; membership in the reference list comes from the inline citations. */
function parseSearchCards(block) {
  if (block.is_finish !== true || !emptyArray(block.meta_info) || !emptyObject(block.extra_info) || !emptyArray(block.append_fields)) throw invalid("An unfinished search reference block cannot be copied safely.");
  const content = block.content;
  if (!object(content) || Object.keys(content).some((key) => !["search_query_result_block", "pc_event_block"].includes(key)) || content.pc_event_block !== "") throw invalid("An unknown search reference block cannot be copied safely.");
  const search = content.search_query_result_block;
  if (!object(search)) throw invalid("The search reference block is empty.");
  const results = Array.isArray(search.results) ? search.results : [];
  const cards = [];
  for (const result of results) {
    // Only structured text and video cards are understood; anything else is
    // skipped as UI decoration rather than copied as prose.
    const card = result?.text_card ?? result?.video_card;
    if (!object(card)) continue;
    // Video cards carry a caption link instead of a text title.
    const title = typeof card.title === "string" ? card.title.trim() : (typeof card.video_captions === "string" ? card.video_captions.split("\n")[0].trim() : "");
    const link = card.url ?? card.main_site_url;
    const url = typeof link === "string" ? link.trim() : "";
    if (!title || !/^https?:\/\//.test(url)) continue;
    cards.push({ title, url });
  }
  return cards;
}

export const doubaoAdapter = {
  id: "doubao",
  matches(url) {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ["doubao.com", "www.doubao.com"].includes(parsed.hostname) && /^\/chat\/\d+\/?$/.test(parsed.pathname);
  },
  async extractConversation({ url, fetch }) {
    const parsed = new URL(url), id = parsed.pathname.match(/^\/chat\/(\d+)\/?$/)?.[1];
    if (!id) throw new CopyError(ErrorCode.MISSING_CONVERSATION_ID, "Open a saved Doubao conversation first.");
    // Observed static parameters only. No stored device identifiers or tokens.
    const endpoint = new URL("https://www.doubao.com/im/chain/single");
    for (const [key, value] of Object.entries({ version_code: "20800", language: "zh", device_platform: "web", doubao_device_platform: "web", aid: "497858", real_aid: "497858", pkg_type: "release_version", pc_version: "3.45.0", "doubao_pc_version": "3.45.0", region: "CN", sys_region: "CN", samantha_web: "1", web_platform: "browser", "use-olympus-account": "1" })) endpoint.searchParams.set(key, value);
    const response = await fetch(endpoint.href, {
      method: "POST", credentials: "include", headers: { accept: "application/json, text/plain, */*", "content-type": "application/json; encoding=utf-8", "agw-js-conv": "str" },
      body: JSON.stringify({ cmd: 3100, uplink_body: { pull_singe_chain_uplink_body: { conversation_id: id, anchor_index: Number.MAX_SAFE_INTEGER, conversation_type: 3, direction: 1, limit: 20, ext: {}, filter: { index_list: [] }, evaluate_ab_params: "", evaluate_common_params: "", option: { lazy_load_strategy: 0 } } }, sequence_id: crypto.randomUUID(), channel: 2, version: "1" })
    });
    if (!response.ok) throw responseError(response.status, "Doubao");
    const data = await response.json();
    try {
      return parseDoubaoConversation(data, id);
    } catch (error) {
      // Keep a content-free shape summary on the error for diagnosis, but leave
      // the user-facing message short. Read error.shape in a dev console to see
      // which guard rejected the response.
      if (error instanceof CopyError && error.code === ErrorCode.INVALID_RESPONSE) {
        error.shape = summarizeDoubaoResponse(data, id);
      }
      throw error;
    }
  }
};
