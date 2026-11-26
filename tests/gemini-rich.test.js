import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { parseGeminiConversation, decodeGeminiHistory } from "../src/platforms/gemini.js";
import { formatConversation } from "../src/core/format.js";
import { isBlank, resolveCitations, documentSources, renderCandidate } from "../src/platforms/gemini-rich.js";
import { evidenceFiles, surveyDir } from "./helpers/evidence.js";

const id = "0123456789abcdef";
const conversations = () => JSON.parse(readFileSync(new URL("fixtures/gemini-rich.json", import.meta.url), "utf8")).conversations;
const parse = (name) => parseGeminiConversation(structuredClone(conversations()[name]), id);
const body = (name, index) => parse(name).messages[index].text;

describe("Gemini rich content", () => {
  it("keeps a multi-turn chain in order, oldest first", () => {
    const conversation = parse("multi");
    expect(conversation.messages.map(m => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(conversation.messages.map(m => m.text)).toEqual([
      "USER_GEMINI_ONE", "ASSISTANT_GEMINI_ONE",
      "USER_GEMINI_TWO", "ASSISTANT_GEMINI_TWO",
      "USER_GEMINI_THREE", "ASSISTANT_GEMINI_THREE"
    ]);
  });

  it("renders uploaded files without their signed URLs", () => {
    const conversation = parse("uploaded");
    expect(conversation.messages[0].attachments).toEqual([{ name: "photo_one.png", type: "image/png" }]);
    const out = formatConversation(conversation);
    expect(out).toContain("[Attachment: photo_one.png]");
    expect(out).not.toMatch(/googleusercontent|\$AfSIGNED/);
  });

  it("renders a generated image as its prompt, never its signed URL", () => {
    const out = formatConversation(parse("generated"));
    expect(out).toContain("[Image: GENERATED_PROMPT_TEXT]");
    expect(out).not.toMatch(/googleusercontent|\$AfSIGNED|watermarked_img_test/);
  });

  it("renders a document body with resolved citations", () => {
    const out = formatConversation(parse("documented"));
    expect(out).toContain("[Gemini document: DOCUMENT_TITLE]");
    expect(out).toContain("DOCUMENT_BODY_ONE ([EXAMPLE ONE](https://example.com/one))");
    expect(out).toContain("DOCUMENT_BODY_TWO ([EXAMPLE TWO](https://example.org/two))");
    expect(out).not.toMatch(/\[cite:|googleusercontent|faviconV2|im_document_test/);
  });

  it("renders a Deep Research plan card as visible steps", () => {
    const out = formatConversation(parse("planned"));
    expect(out).toContain("[Gemini plan: PLAN_TITLE]");
    expect(out).toContain("1. PLAN_STEP_ONE — PLAN_DETAIL_ONE");
    expect(out).toContain("2. PLAN_STEP_TWO");
    expect(out).toContain("3. PLAN_STEP_THREE");
    expect(out).toContain("PLAN_ESTIMATE");
    expect(out).not.toContain("googleusercontent");
  });

  it("never copies reasoning", () => {
    const conversation = parse("reasoned");
    expect(conversation.messages[1].text).toBe("ASSISTANT_GEMINI_REASON");
    expect(JSON.stringify(conversation)).not.toMatch(/Private reasoning|Considered the request/);
  });

  it("copies only the selected candidate", () => {
    const conversation = parse("alternatives");
    expect(conversation.messages[1].text).toBe("ASSISTANT_GEMINI_ALT_SELECTED");
    expect(JSON.stringify(conversation)).not.toContain("ASSISTANT_GEMINI_ALT_OLD");
  });

  it("keeps progress steps and tool calls out of the copy", () => {
    const conversation = parse("stepped");
    expect(conversation.messages[1].text).toBe("ASSISTANT_GEMINI_STEPS");
    expect(JSON.stringify(conversation)).not.toMatch(/STEP_TITLE|TOOL_ACTION|data_analysis_tool/);
  });

  it("emits a placeholder instead of dropping unknown visible content", () => {
    const out = formatConversation(parse("unknownField"));
    expect(out).toContain("[Gemini content: answer field 40]");
  });

  it("decodes the survey recordings from their RPC envelope", () => {
    const data = JSON.parse(readFileSync(new URL("fixtures/gemini.json", import.meta.url), "utf8")).conversations.single;
    const framed = `)]}'\n123\n${JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify(data), null]])}\n`;
    expect(parseGeminiConversation(decodeGeminiHistory(framed), id).messages).toHaveLength(2);
  });

  it("shows a placeholder for an empty reply instead of an empty message", () => {
    expect(formatConversation(parse("emptyReply"))).toContain("[Gemini content: empty reply]");
  });

  it("resolves markers only through the citation table", () => {
    const sources = new Map([[1, { title: "ONE", url: "https://example.com/one" }]]);
    expect(resolveCitations("a [cite: 1] b", sources)).toBe("a ([ONE](https://example.com/one)) b");
    expect(resolveCitations("a [cite: 9] b", sources)).toBe("a (citation) b");
    expect(resolveCitations("a [cite: 1, 9] b", sources)).toBe("a ([ONE](https://example.com/one)) (citation) b");
  });

  it("treats flag-only and empty values as nothing to render", () => {
    for (const value of [null, [], [null], [2], [false], [null, null, 8], [null, null, null, null, [null, null, 7]]]) expect(isBlank(value) || renderCandidate([`rc_1`, ["x"], ...Array(28), value]).placeholders.length === 0).toBe(true);
    expect(renderCandidate(["rc_1", ["x"]]).text).toBe("x");
  });

  it("decodes documents and citations from their declared slots", () => {
    const data = conversations().documented[0][0];
    expect(documentSources(data[3][0][0][30][0]).size).toBe(2);
  });
});

const files = evidenceFiles(surveyDir("gemini"), { withUrl: true });
const conversationId = (path) => readFileSync(path, "utf8").trim().match(/\/app\/([a-f0-9]{16})\/?$/)?.[1];
const results = files.map(({ index, path, urlPath }) => {
  const conversation = parseGeminiConversation(decodeGeminiHistory(readFileSync(path, "utf8")), conversationId(urlPath));
  return { index, conversation, formatted: formatConversation(conversation), records: decodeGeminiHistory(readFileSync(path, "utf8"))[0] };
});

describe.skipIf(!files.length)("Gemini survey recordings (CHATCOPY_EVIDENCE)", () => {
  it("decodes and parses every recorded conversation", () => {
    expect(results).toHaveLength(files.length);
  });

  it("keeps roles alternating and one turn per record", () => {
    for (const { index, conversation, records } of results) {
      expect(conversation.messages.length, `conversation ${index}`).toBe(records.length * 2);
      conversation.messages.forEach((message, i) => expect(message.role, `conversation ${index} message ${i}`).toBe(i % 2 === 0 ? "user" : "assistant"));
    }
  });

  it("never leaks ids, signed URLs or rendering debris", () => {
    for (const { index, formatted } of results) {
      expect(formatted, `conversation ${index}`).not.toMatch(/\b(?:rc?)_[a-f0-9]{8,}/);
      expect(formatted, `conversation ${index}`).not.toMatch(/googleusercontent|gstatic\.com\/favicon/);
      expect(formatted, `conversation ${index}`).not.toMatch(/\[object Object\]|undefined|NaN|\[cite:/);
    }
  });

  it("keeps thinking out of the copy", () => {
    for (const { index, conversation } of results) {
      const text = JSON.stringify(conversation);
      expect(text, `conversation ${index}`).not.toMatch(/\*\*(?:Analyzed request|Drafted|Refining|Generating research plan)/);
    }
  });
});
