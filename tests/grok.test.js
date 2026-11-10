import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grokAdapter, parseGrokConversation } from "../src/platforms/grok.js";

const fixture = () => JSON.parse(readFileSync(new URL("fixtures/grok.json", import.meta.url), "utf8"));
const conversationUrl = "https://grok.com/c/11111111-2222-4333-8444-555555555555";

// Build one user question plus one assistant answer on the active branch.
function conversation(answer) {
  return {
    title: "Attachments",
    currentResponseId: "a1",
    responses: [
      { responseId: "u1", parentResponseId: "conversation-root", sender: "user", message: "Question" },
      { responseId: "a1", parentResponseId: "u1", sender: "assistant", ...answer }
    ]
  };
}

const answerOf = (data) => parseGrokConversation(data).messages[1];

describe("Grok adapter", () => {
  it("matches grok.com and requires a saved conversation id", async () => {
    expect(grokAdapter.matches(conversationUrl)).toBe(true);
    expect(grokAdapter.matches("https://example.com/c/1")).toBe(false);
    await expect(grokAdapter.extractConversation({ url: "https://grok.com/", fetch: () => {} }))
      .rejects.toMatchObject({ code: "missing_conversation_id" });
  });

  it("keeps the existing text-only behaviour for message, text and content strings", () => {
    expect(answerOf(conversation({ message: "  Plain\n\n\nmessage  " })).text).toBe("Plain\n\nmessage");
    expect(answerOf(conversation({ text: "Plain text" })).text).toBe("Plain text");
    expect(answerOf(conversation({ content: "Plain content" })).text).toBe("Plain content");
  });

  it("keeps attachments alongside each string body form", () => {
    const attachments = {
      imageAttachments: [{ file_name: "chart.png" }],
      fileAttachments: [{ file_name: "report.pdf" }]
    };
    const expected = "Body\n\n[Attachment: chart.png]\n\n[Attachment: report.pdf]";
    for (const field of ["message", "text", "content"]) {
      expect(answerOf(conversation({ [field]: "Body", ...attachments })).text).toBe(expected);
    }
  });

  it("keeps attachments that use the placeholder type fallbacks", () => {
    const data = conversation({
      message: "Body",
      imageAttachments: [{ content_type: "image/png" }],
      fileAttachments: [{ name: "notes.md" }]
    });
    expect(answerOf(data).text).toBe("Body\n\n[Image]\n\n[Attachment: notes.md]");
  });

  it("keeps attachments alongside block bodies and ignores their text fields", () => {
    const data = conversation({
      content: [
        { type: "text", text: "Answer" },
        { type: "code", language: "js" },
        { type: "thinking", text: "hidden" }
      ],
      imageAttachments: [{ file_name: "diagram.png" }],
      fileAttachments: []
    });
    expect(answerOf(data).text).toBe("Answer\n\n[Unsupported content: code]\n\n[Attachment: diagram.png]");
  });

  it("returns attachments for responses without a body", () => {
    expect(answerOf(conversation({ imageAttachments: [{ file_name: "only.png" }] })).text)
      .toBe("[Attachment: only.png]");
    expect(answerOf(conversation({ fileAttachments: [{ file_name: "only.pdf" }] })).text)
      .toBe("[Attachment: only.pdf]");
  });

  it("still selects only the active branch and skips responses with no content", () => {
    const data = fixture();
    data.currentResponseId = "a2";
    data.responses.push({
      responseId: "a3",
      parentResponseId: "u1",
      sender: "assistant",
      imageAttachments: [{ file_name: "branch.png" }]
    });
    expect(parseGrokConversation(data, "grok-fixture").messages).toEqual([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Current branch" }
    ]);

    data.currentResponseId = "a3";
    expect(parseGrokConversation(data, "grok-fixture").messages).toEqual([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "[Attachment: branch.png]" }
    ]);
  });

  it("maps a failed conversation request to an invalid-response error", async () => {
    const fetch = async () => ({ ok: false, status: 404 });
    await expect(grokAdapter.extractConversation({ url: conversationUrl, fetch }))
      .rejects.toMatchObject({ code: "invalid_response" });
  });
});
