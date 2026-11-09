import { attachmentPlaceholder, cleanText, textFromBlocks } from "../core/content.js";
import { CopyError, ErrorCode, responseError } from "../core/errors.js";
import { pathId, strictCurrentPath, uniqueMessages } from "./shared.js";

export function parseClaudeConversation(data) {
  if (!Array.isArray(data?.chat_messages)) {
    throw new CopyError(ErrorCode.INVALID_RESPONSE, "Claude returned an unsupported conversation response.");
  }
  const nodes = strictCurrentPath(data.chat_messages, data.current_leaf_message_uuid, {
    id: (message) => message?.uuid,
    parent: (message) => message?.parent_message_uuid,
    // Claude currently uses a conversation-root sentinel that is not included
    // in chat_messages. Only index 0 may terminate at that missing sentinel.
    allowDanglingRoot: (message) => message?.index === 0
  });
  const messages = uniqueMessages(nodes.map((message) => {
    const role = message.sender === "human" ? "user" : message.sender === "assistant" ? "assistant" : "";
    if (!role) return null;
    const body = textFromBlocks(message.content) || cleanText(message.text || "");
    const extras = [...(message.attachments || []), ...(message.files || [])].map(attachmentPlaceholder);
    const text = cleanText([body, ...extras].filter(Boolean).join("\n\n"));
    return text ? { role, text } : null;
  }).filter(Boolean));
  return { platform: "claude", id: data.uuid || "", title: data.name || "", messages };
}

async function organizationId(fetch) {
  const response = await fetch("https://claude.ai/api/organizations", { credentials: "include", headers: { accept: "application/json" } });
  if (!response.ok) throw responseError(response.status, "Claude");
  const organizations = await response.json();
  const id = Array.isArray(organizations) ? organizations[0]?.uuid : "";
  if (!id) throw new CopyError(ErrorCode.NOT_SIGNED_IN, "Sign in to Claude and try again.");
  return id;
}

export const claudeAdapter = {
  id: "claude",
  matches(url) { return new URL(url).hostname === "claude.ai"; },
  async extractConversation({ url, fetch }) {
    const conversationId = pathId(url, "chat");
    if (!conversationId) throw new CopyError(ErrorCode.MISSING_CONVERSATION_ID, "Open a saved Claude conversation first.");
    const orgId = await organizationId(fetch);
    const endpoint = `https://claude.ai/api/organizations/${encodeURIComponent(orgId)}/chat_conversations/${encodeURIComponent(conversationId)}?tree=true&rendering_mode=messages&render_all_tools=true`;
    const response = await fetch(endpoint, { credentials: "include", headers: { accept: "application/json" } });
    if (!response.ok) throw responseError(response.status, "Claude");
    return parseClaudeConversation(await response.json());
  }
};
