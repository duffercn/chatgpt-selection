import { cleanText } from "./content.js";

const LABELS = { user: "User", tool: "Tool", system: "System" };
const ASSISTANT_LABELS = { chatgpt: "ChatGPT", claude: "Claude", grok: "Grok", deepseek: "DeepSeek", perplexity: "Perplexity", qianwen: "Qianwen", doubao: "Doubao", gemini: "Gemini" };

function formatAttachment(item) {
  const name = item?.name || item?.fileName;
  if (name) return `[Attachment: ${name}]`;
  return /image/i.test(item?.type || "") ? "[Image]" : `[${item?.type || "Attachment"}]`;
}

function formatReference(item) {
  const title = item?.title || item?.url || "Source";
  return item?.url ? `[Source: ${title}](${item.url})` : `[Source: ${title}]`;
}

export function formatConversation(conversation) {
  return conversation.messages
    .map(({ role, text, attachments = [], references = [] }) => {
      const label = role === "assistant" ? ASSISTANT_LABELS[conversation.platform] || "Assistant" : LABELS[role] || "Message";
      const body = cleanText([
        text,
        ...attachments.map(formatAttachment),
        ...references.map(formatReference)
      ].filter(Boolean).join("\n\n"));
      return `${label}:\n${body}`;
    })
    .join("\n\n---\n\n");
}
