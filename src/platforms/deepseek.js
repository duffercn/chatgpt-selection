import { attachmentPlaceholder, cleanText } from "../core/content.js";
import { CopyError, ErrorCode, responseError } from "../core/errors.js";
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

function fragmentType(fragment) {
  return String(fragment?.type || fragment?.fragment_type || "").toUpperCase();
}

function fragmentText(fragment) {
  if (typeof fragment === "string") return fragment;
  if (!fragment || typeof fragment !== "object") return "";
  const type = fragmentType(fragment);
  if (["THINKING", "THOUGHT", "REASONING"].includes(type)) return "";
  const content = typeof fragment.content === "string" ? fragment.content
    : typeof fragment.text === "string" ? fragment.text
      : typeof fragment.value === "string" ? fragment.value
        : "";
  if (["TEXT", "REQUEST", "RESPONSE", "MARKDOWN"].includes(type)) return content;
  if (type === "CODE") {
    const language = fragment.language || fragment.lang || "";
    return content ? `\`\`\`${language}\n${content}\n\`\`\`` : "";
  }
  if (["FILE", "ATTACHMENT", "IMAGE"].includes(type)) return attachmentPlaceholder(fragment);
  return type ? `[DeepSeek content: ${type}]` : "[DeepSeek content: unknown]";
}

function messageText(message) {
  const fragments = message?.fragments;
  const body = Array.isArray(fragments)
    ? fragments.map(fragmentText).filter(Boolean).join("\n\n")
    : typeof message?.content === "string" ? message.content : "";
  const attachments = [...(message?.attachments || []), ...(message?.files || [])]
    .map(attachmentPlaceholder);
  return cleanText([body, ...attachments].filter(Boolean).join("\n\n"));
}

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
    return role && text ? { id: message.message_id, role, text } : null;
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
