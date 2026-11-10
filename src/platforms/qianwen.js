import { cleanText } from "../core/content.js";
import { CopyError, ErrorCode, responseError } from "../core/errors.js";
import { uniqueMessages } from "./shared.js";

// Verified against a real two-turn qianwen.com (China) conversation:
// GET chat2-api.qianwen.com/api/v1/session/msg/list returned code 0 with two
// records (newest first). Cookies authenticate the request; the API also
// requires a `ut` client UUID but accepts any fresh random UUID, so a
// throwaway identifier is generated per call instead of reading the site's
// stored device id or persisting a token.
const CHAT_ORIGIN = "https://chat2-api.qianwen.com";
const SESSION_PATH = /^\/chat\/([0-9a-zA-Z-]+)\/?$/;
const MSG_LIST_QUERY = "biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&la=zh-CN&tz=Asia%2FSingapore&wv=4.13.5&tq=SD&ve=4.13.5&forward=false&include_pos=false&return_response_messages=true&event_filter=all";
const PAGE_SIZE = 10;

// Observed response_messages kinds. Only the assistant's rendered Markdown
// carries conversation text; the rest are intent/operation metadata, source
// cards, follow-up suggestion UI, or survey UI.
const ASSISTANT_BODY = "multi_load/iframe";
const UI_ONLY_MESSAGES = [
  "signal/post", "bar/progress", "bar/iframe", "survey/card", "paa/iframe"
];

function invalid(message) {
  return new CopyError(ErrorCode.INVALID_RESPONSE, `Qianwen ${message}`);
}

function randomUuid() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoApi?.getRandomValues) cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function conversationId(url) {
  if (!["qianwen.com", "www.qianwen.com"].includes(new URL(url).hostname)) return "";
  return new URL(url).pathname.match(SESSION_PATH)?.[1] || "";
}

function sameKind(message, kind) {
  return message?.mime_type === kind && message?.sub_type === undefined;
}

function requirePlainUserText(record, where) {
  const messages = record?.request_messages;
  if (!Array.isArray(messages) || messages.length !== 1) {
    throw invalid(`${where} has ${Array.isArray(messages) ? messages.length : "no"} user request messages; attachments or multi-part prompts are not supported yet.`);
  }
  const message = messages[0];
  if (message?.mime_type !== "text/plain") {
    throw invalid(`${where} has an unsupported user message type "${String(message?.mime_type)}".`);
  }
  if (typeof message.content !== "string" || !message.content.trim()) {
    throw invalid(`${where} has an empty user message.`);
  }
  // meta_data.ori_query repeats the same prompt; the content above is the
  // whole user text and must not be concatenated with anything else.
  return message.content;
}

function assistantBody(record, where) {
  const messages = record?.response_messages;
  if (!Array.isArray(messages) || !messages.length) throw invalid(`${where} has no assistant response messages.`);
  const bodies = [];
  const unknown = [];
  for (const [index, message] of messages.entries()) {
    if (message?.status !== "complete") {
      throw invalid(`${where} response message ${index} is in state "${String(message?.status)}"; wait for the answer to finish and retry.`);
    }
    if (sameKind(message, ASSISTANT_BODY)) {
      if (typeof message.content !== "string" || !message.content.trim()) throw invalid(`${where} has an empty answer body.`);
      const extras = message.meta_data?.multi_load;
      if (extras !== undefined && (!Array.isArray(extras) || extras.some((extra) => extra?.type !== "inline_action_reply"))) throw invalid(`${where} has unsupported rich answer content.`);
      if (Object.keys(message.meta_data?.ext_info || {}).length) throw invalid(`${where} has unverified answer metadata.`);
      let content = message.content;
      for (const extra of extras || []) {
        if (typeof extra.source_seq !== "string" || !/^inline_action_reply_\d+$/.test(extra.source_seq)) throw invalid(`${where} has an unrecognized follow-up binding.`);
        // The API embeds a marker for each suggested-reply button in the
        // Markdown. Remove only markers bound to an observed UI-only item.
        content = content.replaceAll(`[[${extra.source_seq}]]`, "");
      }
      if (/\[\[inline_action_reply_[^\]]+\]\]/.test(content)) throw invalid(`${where} has an unresolved follow-up marker.`);
      if (!content.trim()) throw invalid(`${where} has no answer text after removing UI markers.`);
      bodies.push(content);
      continue;
    }
    if (UI_ONLY_MESSAGES.some((kind) => sameKind(message, kind))) {
      if (message.mime_type === "bar/iframe" && (!Array.isArray(message.meta_data?.sources) || message.meta_data.sources.length)) throw invalid(`${where} has unsupported source cards.`);
      if (message.mime_type === "paa/iframe") {
        // A real five-turn response included this entirely empty follow-up
        // container. Any populated variant needs its own live evidence.
        const meta = message.meta_data;
        const append = meta?.append_msg;
        if (meta?.show_type !== "" || meta.scene !== "" || !Array.isArray(meta.paas) || meta.paas.length || !Array.isArray(meta.exclusive_card_types) || meta.exclusive_card_types.length || append?.content !== "" || append.mime_type !== "" || append.status !== "" || !Array.isArray(append.meta_data?.multi_load) || append.meta_data.multi_load.length) throw invalid(`${where} has unsupported follow-up content.`);
      }
      if (message.content !== undefined && message.content !== "" && message.content !== null) {
        throw invalid(`${where} ${message.sub_type}/${message.mime_type} block unexpectedly carries content; visible text could be lost.`);
      }
      continue;
    }
    unknown.push(message.sub_type ? `${message.mime_type}/${message.sub_type}` : String(message.mime_type));
  }
  if (unknown.length) throw invalid(`${where} has unsupported response blocks (${unknown.join(", ")}); visible content could be lost.`);
  if (bodies.length !== 1) throw invalid(`${where} has ${bodies.length} assistant answer bodies; only a single complete answer is supported.`);
  return bodies[0];
}

function recordTurn(record, index, sessionId) {
  const where = `record ${index}`;
  if (!record || typeof record !== "object") throw invalid(`${where} is not an object.`);
  if (record.session_id !== sessionId) {
    throw invalid(`${where} belongs to a different session (${String(record.session_id)}).`);
  }
  if (typeof record.req_id !== "string" || !record.req_id) throw invalid(`${where} has no request id.`);
  if (record.event !== "complete") throw invalid(`${where} is in event state "${String(record.event)}"; wait for the answer to finish and retry.`);
  if (record.error_code !== 0) throw invalid(`${where} reported error_code ${String(record.error_code)}: ${String(record.error_msg || "unknown error")}.`);
  const createdAt = record.created_at;
  if (!Number.isFinite(createdAt) || createdAt <= 0) throw invalid(`${where} has no reliable creation time; the question order cannot be restored.`);
  return {
    reqId: record.req_id,
    createdAt,
    user: cleanText(requirePlainUserText(record, where)),
    assistant: cleanText(assistantBody(record, where))
  };
}

export function parseQianwenConversation(data, fallbackConversationId = "") {
  if (!data || typeof data !== "object") throw invalid("returned an empty response body.");
  if (data.code !== 0 || data.success !== true) {
    throw invalid(`reported code ${String(data.code)}${data.msg ? ` (${String(data.msg)})` : ""}; the complete conversation could not be verified.`);
  }
  const payload = data.data;
  if (!payload || typeof payload !== "object") throw invalid("returned no conversation data.");
  // Pagination was never observed beyond a single page, so a non-false flag is
  // rejected rather than guessing a cursor protocol.
  if (payload.have_next_page !== false) {
    throw invalid(`reported have_next_page ${String(payload.have_next_page)}; the returned page may not hold the whole conversation.`);
  }
  if (!Array.isArray(payload.list) || !payload.list.length) throw invalid("returned no conversation records.");

  const sessionIds = new Set(payload.list.map((record) => record?.session_id));
  if (sessionIds.size !== 1) throw invalid("returned records from more than one session.");
  const sessionId = [...sessionIds][0];
  if (typeof sessionId !== "string" || !sessionId) throw invalid("returned records without a session id.");
  if (fallbackConversationId && sessionId !== fallbackConversationId) throw invalid("returned a different session than the open conversation.");

  const turns = payload.list.map((record, index) => recordTurn(record, index, sessionId));
  if (new Set(turns.map((turn) => turn.reqId)).size !== turns.length) throw invalid("returned duplicate request ids.");
  if (new Set(turns.map((turn) => turn.createdAt)).size !== turns.length) {
    throw invalid("returned records with identical creation times; the question order cannot be restored.");
  }
  // Records arrive newest first; created_at ascending restores the asked order.
  turns.sort((left, right) => left.createdAt - right.createdAt);

  const messages = uniqueMessages(turns.flatMap((turn) => [
    { id: `${turn.reqId}:user`, role: "user", text: turn.user },
    { id: `${turn.reqId}:assistant`, role: "assistant", text: turn.assistant }
  ]));
  return { platform: "qianwen", id: sessionId || fallbackConversationId, title: "", messages };
}

export const qianwenAdapter = {
  id: "qianwen",
  matches(url) { return Boolean(conversationId(url)); },
  async extractConversation({ url, fetch }) {
    const id = conversationId(url);
    if (!id) throw new CopyError(ErrorCode.MISSING_CONVERSATION_ID, "Open a saved Qianwen conversation first.");
    const endpoint = `${CHAT_ORIGIN}/api/v1/session/msg/list?${MSG_LIST_QUERY}`
      + `&session_id=${encodeURIComponent(id)}&page_size=${PAGE_SIZE}&page=1&ut=${randomUuid()}`;
    const response = await fetch(endpoint, { credentials: "include", headers: { accept: "application/json" } });
    if (!response.ok) throw responseError(response.status, "Qianwen");
    return parseQianwenConversation(await response.json(), id);
  }
};
