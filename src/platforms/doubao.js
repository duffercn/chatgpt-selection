import { CopyError, ErrorCode, responseError } from "../core/errors.js";
import { summarizeDoubaoResponse } from "./doubao-shape.js";

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
    if (![1, 2].includes(message.user_type) || message.status !== 0 || message.content_status !== 0 || message.content_type !== 9999 || message.content !== "" || message.ext?.is_finish !== "1" || message.ext?.use_content_block !== "1") throw invalid("A message is unfinished or uses an unverified content format.");
    if (!emptyArray(message.regen_msg_list) || typeof message.section_id !== "string" || !message.section_id) throw invalid("The active section or regeneration history is ambiguous.");
    sections.add(message.section_id);
    const parsed = parseContentBlocks(message);
    return { message, index: BigInt(message.index_in_conv), text: parsed.text, references: parsed.references };
  }).sort((a, b) => a.index < b.index ? -1 : a.index > b.index ? 1 : 0);
  if (records[0].index !== 1n || sections.size !== 1) throw invalid("The beginning or active section of the conversation is incomplete.");
  for (let index = 0; index < records.length; index++) {
    const current = records[index].message, previous = records[index - 1]?.message;
    if (current.user_type !== (index % 2 === 0 ? 1 : 2) || (current.user_type === 2 && current.bot_reply_message_id !== previous?.message_id)) throw invalid("The current reply chain is ambiguous.");
  }
  return { platform: "doubao", id: conversationId, title: "", messages: records.map(({ message, text, references }) => ({ id: message.message_id, role: message.user_type === 1 ? "user" : "assistant", text, references })) };
}

/**
 * A message carries one prose block and, when the reply used web search, an
 * extra 10025 block holding cited sources. The sources are surfaced as
 * references; anything else is still rejected rather than silently dropped.
 */
function parseContentBlocks(message) {
  const blocks = message?.content_block;
  if (!Array.isArray(blocks) || !blocks.length) throw invalid("A message has no content blocks.");
  const prose = blocks.filter((block) => block?.block_type === 10000);
  const search = blocks.filter((block) => block?.block_type === 10025);
  const other = blocks.filter((block) => ![
    10000, 10025
  ].includes(block?.block_type));
  if (prose.length !== 1) throw invalid("Expected exactly one prose block per message.");
  if (other.length) throw invalid("The message contains unverified rich content.");
  if (search.length > 1) throw invalid("Multiple search reference blocks require additional verification.");

  const content = prose[0].content, text = content?.text_block;
  if (prose[0].is_finish !== true || !emptyArray(prose[0].meta_info) || !emptyObject(prose[0].extra_info) || !emptyArray(prose[0].append_fields)) throw invalid("An unknown or unfinished rich block cannot be copied safely.");
  if (!object(content) || Object.keys(content).some((key) => !["text_block", "pc_event_block"].includes(key)) || content.pc_event_block !== "" || !object(text) || Object.keys(text).some((key) => !["text", "icon_url", "icon_url_dark", "summary"].includes(key)) || text.icon_url !== "" || text.icon_url_dark !== "" || text.summary !== "" || typeof text.text !== "string" || !text.text.trim()) throw invalid("The message contains unverified visible content.");

  return { text: text.text, references: search.length ? parseSearchReferences(search[0]) : [] };
}

/** Maps a 10025 search block onto the shared reference shape. */
function parseSearchReferences(block) {
  if (block.is_finish !== true || !emptyArray(block.meta_info) || !emptyObject(block.extra_info) || !emptyArray(block.append_fields)) throw invalid("An unfinished search reference block cannot be copied safely.");
  const content = block.content;
  if (!object(content) || Object.keys(content).some((key) => !["search_query_result_block", "pc_event_block"].includes(key)) || content.pc_event_block !== "") throw invalid("An unknown search reference block cannot be copied safely.");
  const search = content.search_query_result_block;
  if (!object(search)) throw invalid("The search reference block is empty.");
  const results = Array.isArray(search.results) ? search.results : [];
  const references = [];
  for (const result of results) {
    // Only structured text cards are understood; anything else is skipped as
    // UI decoration rather than copied as prose.
    const card = result?.text_card;
    if (!object(card)) continue;
    const title = typeof card.title === "string" ? card.title.trim() : "";
    const url = typeof card.url === "string" ? card.url.trim() : "";
    if (!title || !/^https?:\/\//.test(url)) continue;
    references.push({ title, url });
  }
  return references;
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
