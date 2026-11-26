import { attachmentPlaceholder, cleanText } from "../core/content.js";
import { CopyError, ErrorCode, responseError } from "../core/errors.js";
import { convertDilMarkup } from "./chatgpt-dil.js";
import { replaceCitationMarkers } from "./chatgpt-refs.js";
import { pathId, strictCurrentPath, uniqueMessages } from "./shared.js";

function partText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  return attachmentPlaceholder(part);
}

export function parseChatGptConversation(data) {
  if (!data?.mapping || typeof data.mapping !== "object") {
    throw new CopyError(ErrorCode.INVALID_RESPONSE, "ChatGPT returned an unsupported conversation response.");
  }
  const mappingNodes = Object.entries(data.mapping).map(([nodeId, node]) => ({ ...node, id: node?.id || nodeId }));
  const nodes = strictCurrentPath(mappingNodes, data.current_node, {
    id: (node) => node?.id,
    parent: (node) => node?.parent
  });
  const messages = uniqueMessages(nodes.map((node) => {
    const message = node?.message;
    const role = message?.author?.role;
    if (!message || !["user", "assistant"].includes(role)) return null;
    if (message.metadata?.is_visually_hidden_from_conversation) return null;
    const content = message.content;
    const raw =
      typeof content === "string" ? content
        : typeof content?.text === "string" ? content.text
          : typeof content?.result === "string" ? content.result
            : Array.isArray(content?.parts) ? content.parts.map(partText).filter(Boolean).join("\n\n")
              : "";
    // Only flagged DIL replies are converted; user text and plain replies stay as written.
    const dil = role === "assistant" && message.metadata?.model_dil_v2;
    // Citation markers (`\uE200cite…`) are rewritten from content_references first, so
    // both DIL and plain replies come out clean.
    const cited = role === "user" ? raw : replaceCitationMarkers(raw, message.metadata?.content_references);
    const text = cleanText(dil ? convertDilMarkup(cited) : cited);
    return text ? { role, text } : null;
  }).filter(Boolean));
  return { platform: "chatgpt", id: data.conversation_id || "", title: data.title || "", messages };
}

export const chatGptAdapter = {
  id: "chatgpt",
  matches(url) {
    return ["chatgpt.com", "chat.openai.com"].includes(new URL(url).hostname);
  },
  async extractConversation({ url, fetch }) {
    const conversationId = pathId(url, "c");
    if (!conversationId) throw new CopyError(ErrorCode.MISSING_CONVERSATION_ID, "Open a saved ChatGPT conversation first.");
    let token = "";
    const session = await fetch(`${new URL(url).origin}/api/auth/session`, { credentials: "include", headers: { accept: "application/json" } });
    if (session.ok) token = (await session.json())?.accessToken || "";
    const headers = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${new URL(url).origin}/backend-api/conversation/${encodeURIComponent(conversationId)}`, { credentials: "include", headers });
    if (!response.ok) throw responseError(response.status, "ChatGPT");
    return parseChatGptConversation(await response.json());
  }
};
