import { attachmentPlaceholder, cleanText, textFromBlocks } from "../core/content.js";
import { CopyError, ErrorCode, responseError } from "../core/errors.js";
import { pathId, strictCurrentPath, uniqueMessages } from "./shared.js";

export function parseMaybeNdjson(text) {
  try { return JSON.parse(text); } catch (_error) {
    const values = text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
    return values.length === 1 ? values[0] : values;
  }
}

function responseList(data) {
  if (Array.isArray(data)) return data.flatMap((item) => responseList(item));
  if (Array.isArray(data?.responses)) return data.responses;
  if (data?.responses && typeof data.responses === "object") return responseList(Object.values(data.responses));
  if (Array.isArray(data?.conversation?.responses)) return data.conversation.responses;
  if (data?.responseId || data?.id) return [data];
  return [];
}

function activeLeaf(data, nodes) {
  const explicit = data?.currentResponseId || data?.current_response_id || data?.conversation?.currentResponseId;
  if (explicit) return explicit;
  const parents = new Set(nodes.map((node) => node.parentResponseId || node.parent_response_id).filter(Boolean));
  const leaves = nodes.filter((node) => !parents.has(node.responseId || node.id));
  if (leaves.length === 1) return leaves[0].responseId || leaves[0].id;
  throw new CopyError(ErrorCode.INVALID_RESPONSE, "Grok did not identify one active conversation branch.");
}

function nodeText(node) {
  if (typeof node.message === "string") return node.message;
  if (typeof node.text === "string") return node.text;
  if (typeof node.content === "string") return node.content;
  return textFromBlocks(node.content || node.message?.content || node.parts);
}

function grokText(node) {
  const text = nodeText(node);
  const attachments = [...(node.imageAttachments || []), ...(node.fileAttachments || [])]
    .map(attachmentPlaceholder);
  return cleanText([text, ...attachments].filter(Boolean).join("\n\n"));
}

export function parseGrokConversation(data, conversationId = "") {
  const nodes = responseList(data);
  if (!nodes.length) {
    const nestedKeys = data?.responses && typeof data.responses === "object"
      ? `; responses keys: ${Object.keys(data.responses).slice(0, 16).join(",") || "none"}`
      : `; responses type: ${typeof data?.responses}`;
    const shape = Array.isArray(data)
      ? `array(${data.length}) first keys: ${Object.keys(data[0] || {}).slice(0, 12).join(",") || "none"}`
      : `keys: ${Object.keys(data || {}).slice(0, 12).join(",") || "none"}${nestedKeys}`;
    throw new CopyError(ErrorCode.INVALID_RESPONSE, `Grok returned an unsupported conversation response (${shape}).`);
  }
  const path = strictCurrentPath(nodes, activeLeaf(data, nodes), {
    id: (node) => node.responseId || node.id,
    parent: (node) => node.parentResponseId || node.parent_response_id,
    // Grok's full response graph may reference an omitted conversation-root
    // sentinel from its earliest user response.
    allowDanglingRoot: (node) => ["human", "user"].includes(node.sender || node.role || node.author)
  });
  const messages = uniqueMessages(path.map((node) => {
    const sender = node.sender || node.role || node.author;
    const role = ["human", "user"].includes(sender) ? "user" : ["assistant", "grok"].includes(sender) ? "assistant" : "";
    const text = grokText(node);
    return role && text ? { role, text } : null;
  }).filter(Boolean));
  return { platform: "grok", id: conversationId, title: data?.title || data?.conversation?.title || "", messages };
}

export const grokAdapter = {
  id: "grok",
  matches(url) { return new URL(url).hostname === "grok.com"; },
  async extractConversation({ url, fetch }) {
    const conversationId = pathId(url, "c");
    if (!conversationId) throw new CopyError(ErrorCode.MISSING_CONVERSATION_ID, "Open a saved Grok conversation first.");
    const base = `https://grok.com/rest/app-chat/conversations/${encodeURIComponent(conversationId)}`;
    const attempts = [
      { endpoint: `${base}/responses`, options: { credentials: "include", headers: { accept: "application/json" } } },
      { endpoint: `${base}/load-responses`, options: { method: "POST", credentials: "include", headers: { accept: "application/json", "content-type": "application/json" }, body: "{}" } }
    ];
    const errors = [];
    for (const attempt of attempts) {
      const response = await fetch(attempt.endpoint, attempt.options);
      if (!response.ok) {
        errors.push(`${attempt.endpoint.endsWith("load-responses") ? "load-responses" : "responses"}: HTTP ${response.status}`);
        continue;
      }
      try {
        return parseGrokConversation(parseMaybeNdjson(await response.text()), conversationId);
      } catch (error) {
        errors.push(`${attempt.endpoint.endsWith("load-responses") ? "load-responses" : "responses"}: ${error.message}`);
      }
    }
    throw new CopyError(ErrorCode.INVALID_RESPONSE, `Grok extraction attempts failed (${errors.join(" | ") || "no response"}).`);
  }
};
