import { CopyError, ErrorCode, responseError } from "../core/errors.js";

const invalid = (message) => new CopyError(ErrorCode.INVALID_RESPONSE, `Gemini: ${message}`);
const empty = (value) => Array.isArray(value) && value.length === 0;
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
  if (!Array.isArray(data) || data.length !== 4 || data[1] !== null || data[2] !== null || !empty(data[3]) || !Array.isArray(data[0]) || !data[0].length) throw invalid("History is empty, paginated or uses an unverified format.");
  const conversationId = `c_${id}`, seen = new Set();
  const records = data[0];
  const messages = [];
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index], older = records[index + 1];
    if (!Array.isArray(record) || record.length !== 5 || !Array.isArray(record[0]) || record[0].length !== 2 || record[0][0] !== conversationId || !text(record[0][1]) || seen.has(record[0][1])) throw invalid("Conversation identifiers are missing or ambiguous.");
    seen.add(record[0][1]);
    if (older ? !Array.isArray(record[1]) || record[1].length !== 3 || record[1][0] !== conversationId || record[1][1] !== older[0][1] || record[1][2] !== older[3][3] : record[1] !== null) throw invalid("The current branch is incomplete or ambiguous.");
    const user = record[2], response = record[3];
    if (!Array.isArray(user) || user.length !== 11 || !Array.isArray(user[0]) || user[0].length !== 5 || !text(user[0][0]) || user[0].slice(1, 4).some(v => v !== null) || JSON.stringify(user[0][4]) !== "[[]]" || user[1] !== 2 || user[3] !== 1 || user[8] !== false || !empty(user[10]) || [2, 5, 6, 7, 9].some(i => user[i] !== null)) throw invalid("A user message contains unverified rich content.");
    if (!Array.isArray(response) || response.length !== 32 || !Array.isArray(response[0]) || response[0].length !== 1 || response[9] !== true || response[24] !== 3 || response[25] !== 1) throw invalid("A reply is unfinished or has unverified alternatives.");
    const candidate = response[0][0];
    if (!Array.isArray(candidate) || candidate.length !== 38 || !text(candidate[0]) || candidate[0] !== response[3] || !Array.isArray(candidate[1]) || candidate[1].length !== 1 || !text(candidate[1][0]) || JSON.stringify(candidate[8]) !== "[2]" || !empty(candidate[28]) || JSON.stringify(candidate[12]) !== "[null,null,null,null,null,null,null,[]]") throw invalid("The selected answer contains unverified content.");
    const known = new Set([0, 1, 8, 9, 12, 28, 37]);
    if (candidate.some((value, i) => !known.has(i) && value !== null)) throw invalid("An unknown answer field could contain visible content.");
    // response[12] is the duplicate rendering AST; candidate[37] is reasoning.
    messages.push({ id: `${record[0][1]}:user`, role: "user", text: user[0][0] }, { id: candidate[0], role: "assistant", text: candidate[1][0] });
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
