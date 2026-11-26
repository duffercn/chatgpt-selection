import { CopyError, ErrorCode, responseError } from "../core/errors.js";
import { CANDIDATE, HISTORY, RECORD, RESPONSE, USER, USER_PAYLOAD } from "./gemini-layout.js";
import { isBlank, extrasMarkers, hasUnhandledExtras, renderCandidate, userAttachments } from "./gemini-rich.js";

const invalid = (message) => new CopyError(ErrorCode.INVALID_RESPONSE, `Gemini: ${message}`);
const text = (value) => typeof value === "string" && value.trim().length > 0;

export function decodeGeminiHistory(raw) {
  if (typeof raw !== "string" || !raw.startsWith(")]}'")) throw invalid("The history response has an unknown envelope.");
  const matches = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("[")) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { throw invalid("A history frame is malformed."); }
    if (!Array.isArray(frame)) throw invalid("A history frame is malformed.");
    for (const item of frame) if (Array.isArray(item) && item[0] === "wrb.fr" && item[1] === "hNvQHb") matches.push(item);
  }
  if (matches.length !== 1 || typeof matches[0][2] !== "string") throw invalid("The complete history RPC was not returned.");
  try { return JSON.parse(matches[0][2]); } catch { throw invalid("The history payload is malformed."); }
}

export function parseGeminiConversation(data, id) {
  if (!Array.isArray(data) || !Array.isArray(data[HISTORY.records]) || !data[HISTORY.records].length) throw invalid("History is empty or uses an unverified format.");
  if (HISTORY.pagination.some((slot) => !isBlank(data[slot]))) throw invalid("History is paginated; only a complete single-page conversation can be copied.");
  const tail = data[HISTORY.tail];
  if (!Array.isArray(tail)) throw invalid("History has an unverified tail field.");
  if (hasUnhandledExtras(tail)) throw invalid("History has an unverified tail field that could hold visible content.");
  // `data[3]` carries the turn's generated media; it belongs to the newest reply.
  const tailMarkers = extrasMarkers(tail);

  const conversationId = `c_${id}`, seen = new Set();
  const records = data[HISTORY.records];
  const messages = [];
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index], older = records[index + 1];
    if (!Array.isArray(record) || !Array.isArray(record[RECORD.ids]) || !Array.isArray(record[RECORD.response])) throw invalid("A turn is incomplete or uses an unverified format.");
    const ids = record[RECORD.ids];
    if (ids.length !== 2 || ids[0] !== conversationId || !text(ids[1]) || seen.has(ids[1])) throw invalid("Conversation identifiers are missing or ambiguous.");
    seen.add(ids[1]);

    const response = record[RECORD.response];
    const candidates = response[RESPONSE.candidates];
    if (!Array.isArray(candidates) || !candidates.length) throw invalid("A reply is unfinished or has unverified alternatives.");
    const candidate = candidates[0];
    if (!Array.isArray(candidate) || !text(candidate[CANDIDATE.id]) || candidate[CANDIDATE.id] !== response[RESPONSE.id]) throw invalid("The selected answer is missing or ambiguous.");

    // The active branch is the parent chain, oldest to newest: every turn but
    // the oldest names the older turn it continues and the older reply's
    // selected candidate. A fork (an alternative not in the chain) or a
    // competing child makes the chain ambiguous and the copy is refused.
    const parent = record[RECORD.parent];
    if (older) {
      if (!Array.isArray(parent) || parent.length !== 3 || parent[0] !== conversationId || parent[1] !== older[RECORD.ids]?.[1]) throw invalid("The current branch is incomplete or ambiguous.");
      if (parent[2] !== older[RECORD.response]?.[RESPONSE.id]) throw invalid("The current branch points at a different answer than the selected one.");
    } else if (!isBlank(parent)) {
      throw invalid("The oldest turn already continues an earlier one; the history is truncated.");
    }

    const user = record[RECORD.user];
    if (!Array.isArray(user) || !Array.isArray(user[USER.payload]) || typeof user[USER.payload][USER_PAYLOAD.text] !== "string") throw invalid("A user message is incomplete or uses an unverified format.");

    const rendered = renderCandidate(candidate);
    const userText = user[USER.payload][USER_PAYLOAD.text];
    const attachments = userAttachments(user);
    // `response[4]`/`[5]` hold reasoning steps and tool calls (never copied);
    // when they carry an image-generation card, only the card's prompt is kept.
    // `data[3]` describes the newest turn.
    const turnMarkers = [...extrasMarkers([response[4], response[5]]), ...(index === 0 ? tailMarkers : [])];
    const replyText = [rendered.text, ...turnMarkers].filter(Boolean).join("\n\n");
    // A turn whose reply is empty still happened (the user saw the prompt and
    // whatever Gemini returned), so it is kept with an explicit placeholder
    // instead of being dropped.
    messages.push(
      { id: `${ids[1]}:user`, role: "user", text: userText || (attachments.length ? "" : "[Gemini content: prompt not in this field]") },
      { id: candidate[CANDIDATE.id], role: "assistant", text: replyText || (isBlank(candidate[CANDIDATE.text]) ? "[Gemini content: empty reply]" : "[Gemini content: unfinished reply]") }
    );
    if (attachments.length) messages[messages.length - 2].attachments = attachments;
  }
  return { platform: "gemini", id, title: "", messages };
}

export const geminiAdapter = {
  id: "gemini",
  matches(url) {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "gemini.google.com" && /^\/app\/[a-f0-9]{16}\/?$/.test(parsed.pathname);
  },
  async extractConversation({ url, fetch, document }) {
    const parsed = new URL(url), id = parsed.pathname.match(/^\/app\/([a-f0-9]{16})\/?$/)?.[1];
    if (!id) throw new CopyError(ErrorCode.MISSING_CONVERSATION_ID, "Open a saved Gemini conversation first.");
    // Read only ephemeral bootstrap authentication, never chat DOM or storage.
    const bootstrap = Array.from(document?.scripts || []).map(script => script.textContent || "").find(source => source.includes("WIZ_global_data") && source.includes('"SNlM0e"'));
    const match = bootstrap?.match(/"SNlM0e"\s*:\s*("(?:[^"\\]|\\.)*")/);
    let token;
    try { token = match ? JSON.parse(match[1]) : null; } catch { token = null; }
    if (!text(token)) throw new CopyError(ErrorCode.NOT_SIGNED_IN, "Reload the signed-in Gemini conversation and try again.");
    const endpoint = new URL("https://gemini.google.com/_/BardChatUi/data/batchexecute");
    endpoint.searchParams.set("rpcids", "hNvQHb");
    endpoint.searchParams.set("source-path", parsed.pathname);
    endpoint.searchParams.set("hl", "en");
    endpoint.searchParams.set("rt", "c");
    const request = [[["hNvQHb", JSON.stringify([`c_${id}`, 10, null, 1, [0], [4, 12], null, 1]), null, "generic"]]];
    const response = await fetch(endpoint.href, { method: "POST", credentials: "include", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ "f.req": JSON.stringify(request), at: token }).toString() });
    if (!response.ok) throw responseError(response.status, "Gemini");
    return parseGeminiConversation(decodeGeminiHistory(await response.text()), id);
  }
};
