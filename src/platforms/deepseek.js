import { attachmentPlaceholder, cleanText } from "../core/content.js";
import { CopyError, ErrorCode, responseError } from "../core/errors.js";
import { citationMarkers, fragmentText, searchReferences } from "./deepseek-rich.js";
import { strictCurrentPath, uniqueMessages } from "./shared.js";

const CONVERSATION_PATH = /^\/a\/chat\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

function conversationId(url) {
  if (new URL(url).hostname !== "chat.deepseek.com") return "";
  return new URL(url).pathname.match(CONVERSATION_PATH)?.[1] || "";
}

function tokenFromStorage(storage) {
  const raw = storage?.getItem?.("userToken");
  if (!raw) return "";
  let value = raw;
  try { value = JSON.parse(raw); }
  catch (_error) { return raw; }
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object") return "";
    if (typeof value.token === "string") return value.token;
    value = value.value ?? value.data ?? value.payload;
  }
  return "";
}

function messageText(message) {
  const fragments = message?.fragments;
  const list = Array.isArray(fragments) ? fragments : [];
  // Citation markers resolve against the search results of the same message, so
  // the map is built once before the fragments are rendered in order.
  const markers = citationMarkers(list);
  const body = Array.isArray(fragments)
    ? list.map((fragment) => fragmentText(fragment, markers)).filter(Boolean).join("\n\n")
    : typeof message?.content === "string" ? message.content : "";
  const attachments = [...(message?.attachments || []), ...(message?.files || [])]
    .map(attachmentPlaceholder);
  return cleanText([body, ...attachments].filter(Boolean).join("\n\n"));
}

function messageReferences(message) {
  const fragments = Array.isArray(message?.fragments) ? message.fragments : [];
  // Only search results carry verified `{title, url}` pairs; the `references`
  // field on THINK/RESPONSE fragments is reasoning metadata, not sources.
  return searchReferences(fragments);
}

/** Assistant turns whose only fragments are hidden still happened to the user. */
const REASONING_WITHOUT_REPLY = "[Reasoning only; no reply text]";

export function parseDeepSeekConversation(data, fallbackConversationId = "") {
  const payload = data?.data?.biz_data;
  if (!payload?.chat_session || !Array.isArray(payload.chat_messages)) {
    throw new CopyError(ErrorCode.INVALID_RESPONSE, "DeepSeek returned an unsupported conversation response.");
  }
  const leafId = payload.current_message_id || payload.chat_session.current_message_id;
  const path = strictCurrentPath(payload.chat_messages, leafId, {
    id: (message) => message?.message_id,
    parent: (message) => message?.parent_id
  });
  const messages = uniqueMessages(path.map((message) => {
    const rawRole = String(message?.role || message?.sender || "").toLowerCase();
    const role = ["user", "human"].includes(rawRole) ? "user"
      : ["assistant", "bot"].includes(rawRole) ? "assistant" : "";
    const text = messageText(message);
    if (!role) return null;
    // A finished assistant turn that only contains reasoning (`THINK`) has no
    // visible body, yet the user still saw it happen. Keeping an explicit note
    // preserves the turn instead of silently merging its neighbours.
    const body = text || (role === "assistant" && Array.isArray(message?.fragments) ? REASONING_WITHOUT_REPLY : "");
    if (!body) return null;
    const references = messageReferences(message);
    const base = { id: message.message_id, role, text: body };
    // Whether the message is on the current branch is already settled by
    // `strictCurrentPath`; the path order is the conversation order, so the id
    // is stable for a given branch and uniqueMessages still sees distinct ids.
    return references.length ? { ...base, references } : base;
  }).filter(Boolean));
  return {
    platform: "deepseek",
    id: payload.chat_session.chat_session_id || payload.chat_session.id || fallbackConversationId,
    title: payload.chat_session.title || "",
    messages
  };
}

export const deepSeekAdapter = {
  id: "deepseek",
  matches(url) { return Boolean(conversationId(url)); },
  async extractConversation({ url, fetch, storage }) {
    const id = conversationId(url);
    if (!id) {
      throw new CopyError(ErrorCode.MISSING_CONVERSATION_ID, "Open a saved DeepSeek conversation first.");
    }
    const endpoint = `https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${encodeURIComponent(id)}`;
    const token = tokenFromStorage(storage);
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(endpoint, {
      credentials: "include",
      headers
    });
    if (!response.ok) throw responseError(response.status, "DeepSeek");
    return parseDeepSeekConversation(await response.json(), id);
  }
};
