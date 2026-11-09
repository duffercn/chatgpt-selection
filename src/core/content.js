export function cleanText(value = "") {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function attachmentPlaceholder(item) {
  const name = item?.file_name || item?.fileName || item?.name;
  const type = item?.content_type || item?.mime_type || item?.mimeType || item?.type || "Attachment";
  if (name) return `[Attachment: ${name}]`;
  if (/image/i.test(type)) return "[Image]";
  return `[${String(type).replaceAll("_", " ")}]`;
}

export function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return cleanText(blocks.map((block) => {
    if (typeof block === "string") return block;
    if (!block || typeof block !== "object") return "";
    if (block.type === "text" || block.type === "input_text" || block.type === "output_text") {
      return block.text || block.content || "";
    }
    if (block.type === "thinking" || block.type === "reasoning") return "";
    if (block.type === "tool_use" && block.input?.content) {
      const language = block.input.language || "";
      return `\`\`\`${language}\n${block.input.content}\n\`\`\``;
    }
    if (["image", "image_asset_pointer", "document", "file", "attachment"].includes(block.type)) {
      return attachmentPlaceholder(block);
    }
    if (block.type) return `[Unsupported content: ${String(block.type).replaceAll("_", " ")}]`;
    return "";
  }).filter(Boolean).join("\n\n"));
}
