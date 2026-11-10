import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { doubaoAdapter, parseDoubaoConversation } from "../src/platforms/doubao.js";
import { copyCurrentConversation } from "../src/core/copy.js";

const id = "12345678901234567", url = `https://www.doubao.com/chat/${id}`;
const fixture = () => JSON.parse(readFileSync(new URL("fixtures/doubao.json", import.meta.url), "utf8"));
const body = (data) => data.downlink_body.pull_singe_chain_downlink_body;
describe("Doubao observed message-chain API", () => {
  it("routes only saved Doubao chats", () => {
    expect(doubaoAdapter.matches(url)).toBe(true);
    expect(doubaoAdapter.matches(url.replace("www.", ""))).toBe(true);
    for (const other of ["https://www.doubao.com/chat/", "https://www.dola.com/chat/123", "https://www.doubao.com.evil.test/chat/123", "http://www.doubao.com/chat/123"]) expect(doubaoAdapter.matches(other)).toBe(false);
  });
  it("sorts gapped indexes, keeps five rounds, Chinese and code without duplicate TTS", () => {
    const parsed = parseDoubaoConversation(fixture(), id);
    expect(parsed.messages).toHaveLength(10);
    expect(parsed.messages.map((m) => m.id)).toEqual(Array.from({ length: 5 }, (_, index) => [`m${index + 1}-1`, `m${index + 1}-2`]).flat());
    expect(parsed.messages[3].text).toContain("30. 检查长对话完整性。");
    expect(parsed.messages[5].text).toContain("```python\nprint(42)\n```");
    expect(parsed.messages[9].text.endsWith("ASSISTANT_DOUBAO_5_END")).toBe(true);
    expect(parsed.messages[1].text.match(/ASSISTANT_DOUBAO_1_BEGIN/g)).toHaveLength(1);
  });
  it("rejects incomplete, paginated or regenerated history", () => {
    for (const mutate of [d => d.status_code = 1, d => d.cmd = 1, d => body(d).has_more = true, d => delete body(d).has_more, d => body(d).msg_cursor = "2", d => body(d).regen_messages = { other: [] }, d => body(d).messages = [], d => body(d).messages.shift()]) {
      const data = fixture(); mutate(data);
      expect(() => parseDoubaoConversation(data, id)).toThrow();
    }
  });
  it("rejects wrong conversations, ambiguous ordering and wrong parent replies", () => {
    for (const mutate of [m => m[0].conversation_id = "other", m => m[0].message_id = m[1].message_id, m => m[0].index_in_conv = m[1].index_in_conv, m => m[0].index_in_conv = "0", m => m.at(-1).index_in_conv = "3", m => m[0].section_id = "other", m => m[0].bot_reply_message_id = "other", m => m[0].regen_msg_list = ["other"]]) {
      const data = fixture(); mutate(body(data).messages);
      expect(() => parseDoubaoConversation(data, id)).toThrow();
    }
  });
  it("rejects unfinished, rich, attachment or unknown blocks instead of partial success", () => {
    for (const mutate of [m => m.user_type = 3, m => m.status = 1, m => m.content_status = 1, m => m.content_type = 1, m => m.content = "extra", m => m.ext.is_finish = "0", m => m.content_block.push(m.content_block[0]), m => m.content_block[0].block_type = 20000, m => m.content_block[0].is_finish = false, m => m.content_block[0].content.document = "extra", m => m.content_block[0].content.pc_event_block = "extra", m => m.content_block[0].content.text_block.summary = "extra", m => m.content_block[0].content.text_block.text = " ", m => m.content_block[0].extra_info = { visible: "extra" }]) {
      const data = fixture(); mutate(body(data).messages[0]);
      expect(() => parseDoubaoConversation(data, id)).toThrow();
    }
  });
  it("uses the observed POST envelope without stored identifiers or tokens", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => fixture() }));
    const storage = new Proxy({}, { get() { throw Error("Storage read"); } });
    await doubaoAdapter.extractConversation({ url, fetch, storage });
    await doubaoAdapter.extractConversation({ url, fetch, storage });
    const [endpoint, options] = fetch.mock.calls[0];
    expect(new URL(endpoint).pathname).toBe("/im/chain/single");
    expect(endpoint).not.toMatch(/device_id|web_id|tea_uuid|token|web_tab_id/);
    expect(options).toMatchObject({ method: "POST", credentials: "include", headers: { "content-type": "application/json; encoding=utf-8", "agw-js-conv": "str" } });
    const request = JSON.parse(options.body);
    expect(request.uplink_body.pull_singe_chain_uplink_body).toEqual({ conversation_id: id, anchor_index: Number.MAX_SAFE_INTEGER, conversation_type: 3, direction: 1, limit: 20, ext: {}, filter: { index_list: [] }, evaluate_ab_params: "", evaluate_common_params: "", option: { lazy_load_strategy: 0 } });
    expect(request.sequence_id).not.toBe(JSON.parse(fetch.mock.calls[1][1].body).sequence_id);
    expect(JSON.stringify(options)).not.toMatch(/authorization|cookie|fetch_token/i);
  });
  it("maps real HTTP failures and refuses a missing conversation id", async () => {
    for (const [status, code] of [[401, "not_signed_in"], [403, "permission_denied"], [500, "api_unavailable"]]) {
      await expect(doubaoAdapter.extractConversation({ url, fetch: async () => ({ ok: false, status }) })).rejects.toMatchObject({ code });
    }
    await expect(doubaoAdapter.extractConversation({ url: "https://www.doubao.com/chat/", fetch: vi.fn() })).rejects.toMatchObject({ code: "missing_conversation_id" });
  });
  it("formats the validated whole chain before writing once", async () => {
    const writeText = vi.fn();
    const result = await copyCurrentConversation({ adapter: doubaoAdapter, url, fetch: async () => ({ ok: true, json: async () => fixture() }), writeText });
    expect(result).toMatchObject({ ok: true, messages: 10, source: "api" });
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0][0].startsWith("User:\nUSER_DOUBAO_1")).toBe(true);
  });
});
