import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChatGptConversation } from "../src/platforms/chatgpt.js";
import { parseClaudeConversation } from "../src/platforms/claude.js";
import { parseGrokConversation, parseMaybeNdjson } from "../src/platforms/grok.js";
import { adapters, adapterForUrl } from "../src/platforms/registry.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8"));

describe("platform adapters", () => {
  it("routes the five shipping platforms", () => {
    expect(adapterForUrl("https://chatgpt.com/c/123")?.id).toBe("chatgpt");
    expect(adapterForUrl("https://chat.openai.com/c/123")?.id).toBe("chatgpt");
    expect(adapterForUrl("https://claude.ai/chat/123")?.id).toBe("claude");
    expect(adapterForUrl("https://grok.com/c/123")?.id).toBe("grok");
    expect(adapterForUrl("https://chat.deepseek.com/a/chat/s/11111111-2222-4333-8444-555555555555")?.id).toBe("deepseek");
    expect(adapterForUrl("https://www.doubao.com/chat/123")?.id).toBe("doubao");
    expect(adapterForUrl("https://gemini.google.com/app/0123456789abcdef")?.id).toBe("gemini");
    expect(adapterForUrl("https://example.com")).toBeNull();
  });

  it("no longer routes the paused platforms", () => {
    // These adapters stay in the repo for future reference but must not ship.
    expect(adapterForUrl("https://www.perplexity.ai/session/11111111-2222-4333-8444-555555555555")).toBeNull();
    expect(adapterForUrl("https://qianwen.com/chat/11111111222243338444555555555555")).toBeNull();
    expect(adapterForUrl("https://kimi.com/chat/123")).toBeNull();
    expect(adapterForUrl("https://chat.qwen.ai/c/123")).toBeNull();
  });

  it("selects only ChatGPT current_node ancestry and preserves an image placeholder", () => {
    const result = parseChatGptConversation(fixture("chatgpt"));
    expect(result.messages).toEqual([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Current branch\n\n[Image]" }
    ]);
  });

  it("uses ChatGPT mapping keys when nodes omit id fields", () => {
    const data = fixture("chatgpt");
    for (const node of Object.values(data.mapping)) delete node.id;
    expect(parseChatGptConversation(data).messages).toHaveLength(2);
  });

  it("selects only Claude current leaf ancestry and preserves attachments", () => {
    const result = parseClaudeConversation(fixture("claude"));
    expect(result.messages).toEqual([
      { role: "user", text: "Hello\n\n[Attachment: notes.pdf]" },
      { role: "assistant", text: "Current branch" }
    ]);
  });

  it("rejects a dangling Claude parent anywhere except index zero", () => {
    const data = fixture("claude");
    data.chat_messages.find((message) => message.uuid === "a2").parent_message_uuid = "missing";
    expect(() => parseClaudeConversation(data)).toThrow(/incomplete/i);
  });

  it("selects only Grok active response ancestry", () => {
    expect(parseGrokConversation(fixture("grok"), "grok-fixture").messages).toEqual([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Current branch" }
    ]);
  });

  it("accepts Grok response maps keyed by response id", () => {
    const data = fixture("grok");
    data.responses = Object.fromEntries(data.responses.map((response) => [response.responseId, response]));
    expect(parseGrokConversation(data, "grok-fixture").messages).toHaveLength(2);
  });

  it("rejects a dangling Grok parent from an assistant response", () => {
    const data = fixture("grok");
    data.responses.find((response) => response.responseId === "a2").parentResponseId = "missing";
    expect(() => parseGrokConversation(data, "grok-fixture")).toThrow(/incomplete/i);
  });

  it("parses Grok NDJSON", () => {
    expect(parseMaybeNdjson('{"responseId":"1"}\n{"responseId":"2"}')).toHaveLength(2);
  });

  it("fails instead of guessing when the active branch is absent", () => {
    const data = fixture("chatgpt");
    delete data.current_node;
    expect(() => parseChatGptConversation(data)).toThrow(/active conversation branch/i);
  });
});

describe("shipping scope", () => {
  it("registers exactly the six accepted platforms", () => {
    expect(adapters.map((adapter) => adapter.id).sort()).toEqual([
      "chatgpt", "claude", "deepseek", "doubao", "gemini", "grok"
    ]);
  });

  it("declares host permissions and content-script matches for only those hosts", () => {
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    const expected = [
      "https://chatgpt.com/*", "https://chat.openai.com/*", "https://claude.ai/*", "https://gemini.google.com/*",
      "https://grok.com/*", "https://chat.deepseek.com/*",
      "https://doubao.com/*", "https://www.doubao.com/*"
    ];
    expect(manifest.host_permissions.sort()).toEqual([...expected].sort());
    expect(manifest.content_scripts[0].matches.sort()).toEqual([...expected].sort());
    expect(manifest.version).toBe("0.7.0");
    // No host may remain for a paused platform.
    for (const host of ["perplexity", "qianwen", "kimi", "qwen"]) {
      expect(manifest.host_permissions.some((entry) => entry.includes(host))).toBe(false);
    }
  });
});
