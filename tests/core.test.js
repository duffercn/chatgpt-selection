import { describe, expect, it, vi } from "vitest";
import { copyCurrentConversation } from "../src/core/copy.js";
import { formatConversation } from "../src/core/format.js";
import { responseError, toErrorResult } from "../src/core/errors.js";

describe("copy core", () => {
  it("formats all platforms consistently", () => {
    expect(formatConversation({ platform: "chatgpt", messages: [
      { role: "user", text: "Hello" },
      { role: "assistant", text: "```js\n42\n```" }
    ] })).toBe("User:\nHello\n\n────────────────────\n\nChatGPT:\n```js\n42\n```");
  });

  it("formats structured attachments and references", () => {
    expect(formatConversation({ platform: "test", messages: [{
      role: "assistant",
      text: "Answer",
      attachments: [{ name: "notes.pdf", type: "application/pdf" }],
      references: [{ title: "Example", url: "https://example.invalid/source" }]
    }] })).toBe("Assistant:\nAnswer\n\n[Attachment: notes.pdf]\n\n[Source: Example](https://example.invalid/source)");
  });

  it("returns a structured error for an unsupported site", async () => {
    const result = await copyCurrentConversation({ adapter: null });
    expect(result).toMatchObject({ ok: false, code: "unsupported_platform" });
  });

  it("copies an extracted conversation", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const result = await copyCurrentConversation({
      adapter: { extractConversation: vi.fn().mockResolvedValue({ platform: "test", messages: [{ role: "user", text: "Hello" }] }) },
      url: "https://example.com/c/1",
      fetch: vi.fn(),
      document: {},
      navigator: { clipboard: { writeText } }
    });
    expect(result).toMatchObject({ ok: true, platform: "test", messages: 1 });
    expect(writeText).toHaveBeenCalledWith("User:\nHello");
  });

  it("uses an injected clipboard writer when provided", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const result = await copyCurrentConversation({
      adapter: { extractConversation: vi.fn().mockResolvedValue({ platform: "claude", messages: [{ role: "assistant", text: "Hello" }] }) },
      writeText
    });
    expect(result.ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("Claude:\nHello");
  });

  it.each([
    [401, "not_signed_in"],
    [403, "permission_denied"],
    [404, "api_unavailable"]
  ])("maps API status %s to %s", (status, code) => {
    expect(toErrorResult(responseError(status, "Test"))).toMatchObject({ ok: false, code });
  });

  it("does not report success for an empty conversation", async () => {
    const result = await copyCurrentConversation({
      adapter: { extractConversation: vi.fn().mockResolvedValue({ platform: "test", messages: [] }) },
      navigator: { clipboard: { writeText: vi.fn() } }
    });
    expect(result).toMatchObject({ ok: false, code: "empty_conversation" });
  });
});

describe("message separators", () => {
  it("does not use a rule that conversation text can produce", () => {
    const formatted = formatConversation({ platform: "doubao", messages: [
      { role: "user", text: "Q1" },
      { role: "assistant", text: "A1" }
    ] });
    // A bare --- is Markdown syntax that replies commonly emit; the separator
    // must be distinguishable from prose.
    expect(formatted).not.toContain("\n\n---\n\n");
    expect(formatted.split("\n\n").some((line) => /^[─—=]{4,}$/.test(line))).toBe(true);
  });

  it("keeps a horizontal rule inside a reply from looking like a boundary", () => {
    const formatted = formatConversation({ platform: "doubao", messages: [
      { role: "user", text: "Intro\n\n---\n\nMore prose" },
      { role: "assistant", text: "Reply" }
    ] });
    // Exactly one separator: between the two messages.
    const boundaries = formatted.match(/────────────────────/g) || [];
    expect(boundaries).toHaveLength(1);
    expect(formatted).toContain("Intro\n\n---\n\nMore prose");
  });
});
