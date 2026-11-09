import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { deepSeekAdapter, parseDeepSeekConversation } from "../src/platforms/deepseek.js";

const fixture = () => JSON.parse(readFileSync(new URL("fixtures/deepseek.json", import.meta.url), "utf8"));
const conversationUrl = "https://chat.deepseek.com/a/chat/s/11111111-2222-4333-8444-555555555555";

describe("DeepSeek adapter", () => {
  it("matches only a saved DeepSeek UUID conversation URL", () => {
    expect(deepSeekAdapter.matches(conversationUrl)).toBe(true);
    expect(deepSeekAdapter.matches(`${conversationUrl}/`)).toBe(true);
    expect(deepSeekAdapter.matches("https://chat.deepseek.com/a/chat/s/not-a-uuid")).toBe(false);
    expect(deepSeekAdapter.matches(`${conversationUrl}/extra`)).toBe(false);
    expect(deepSeekAdapter.matches("https://deepseek.com/a/chat/s/11111111-2222-4333-8444-555555555555")).toBe(false);
  });

  it("rebuilds only the current branch, preserves ids, and converts visible fragments", () => {
    expect(parseDeepSeekConversation(fixture()).messages).toEqual([
      { id: "u1", role: "user", text: "Hello\n\n[Attachment: notes.pdf]" },
      {
        id: "a2",
        role: "assistant",
        text: "Current branch\n\n```js\nconst ok = true;\n```\n\n[DeepSeek content: SEARCH_RESULT]"
      }
    ]);
  });

  it("rejects an incomplete current branch", () => {
    const data = fixture();
    data.data.biz_data.chat_messages.find((message) => message.message_id === "a2").parent_id = "missing";
    expect(() => parseDeepSeekConversation(data)).toThrow(/incomplete/i);
  });

  it("rejects empty and structurally changed responses", () => {
    expect(() => parseDeepSeekConversation({})).toThrow(/unsupported/i);
    const data = fixture();
    data.data.biz_data.chat_messages = [];
    expect(() => parseDeepSeekConversation(data)).toThrow(/active conversation branch/i);
  });

  it("requests history with the current login and maps authorization errors", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => fixture() });
    const storage = { getItem: vi.fn().mockReturnValue(JSON.stringify({ value: { token: "fixture-token" } })) };
    await expect(deepSeekAdapter.extractConversation({ url: conversationUrl, fetch, storage })).resolves.toMatchObject({
      platform: "deepseek",
      id: "11111111-2222-4333-8444-555555555555"
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=11111111-2222-4333-8444-555555555555",
      { credentials: "include", headers: { accept: "application/json", authorization: "Bearer fixture-token" } }
    );

    const deniedFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(deepSeekAdapter.extractConversation({ url: conversationUrl, fetch: deniedFetch }))
      .rejects.toMatchObject({ code: "permission_denied" });
  });
});
