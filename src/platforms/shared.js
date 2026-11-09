import { CopyError, ErrorCode } from "../core/errors.js";

export function pathId(url, marker) {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const index = parts.indexOf(marker);
  return index >= 0 ? parts[index + 1] || "" : "";
}

export function strictCurrentPath(nodes, leafId, { id, parent, allowDanglingRoot = () => false }) {
  if (!leafId) throw new CopyError(ErrorCode.INVALID_RESPONSE, "The API did not identify the active conversation branch.");
  const byId = new Map(nodes.map((node) => [id(node), node]).filter(([nodeId]) => nodeId));
  if (!byId.has(leafId)) throw new CopyError(ErrorCode.INVALID_RESPONSE, "The active conversation branch was not present in the API response.");
  const result = [];
  const seen = new Set();
  let current = leafId;
  while (current) {
    if (seen.has(current)) throw new CopyError(ErrorCode.INVALID_RESPONSE, "The conversation branch contains a cycle.");
    seen.add(current);
    const node = byId.get(current);
    if (!node) {
      const earliest = result.at(-1);
      if (earliest && allowDanglingRoot(earliest)) break;
      throw new CopyError(ErrorCode.INVALID_RESPONSE, "The active conversation branch is incomplete.");
    }
    result.push(node);
    current = parent(node) || "";
  }
  return result.reverse();
}

export function uniqueMessages(messages) {
  const seen = new Set();
  return messages.filter((message) => {
    if (!message.text) return false;
    if (!message.id) return true;
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}
