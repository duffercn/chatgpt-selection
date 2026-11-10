import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parseQianwenConversation, qianwenAdapter } from "../src/platforms/qianwen.js";

const fixture = () => JSON.parse(readFileSync(new URL("fixtures/qianwen.json", import.meta.url), "utf8"));
const sessionId = "5f0c2d3e-0000-4a1b-9c7d-000000000001";
const conversationUrl = `https://qianwen.com/chat/${sessionId}`;
const record = (data, reqId) => data.data.list.find((item) => item.req_id === reqId);

describe("Qianwen adapter", () => {
  it("uses the observed combined MIME field and rejects a different session or unknown rich content", () => {
    const data = fixture();
    expect(data.data.list[0].response_messages[3].mime_type).toBe("multi_load/iframe");
    expect(data.data.list[0].response_messages[3]).not.toHaveProperty("sub_type");
    expect(() => parseQianwenConversation(data, "other-session")).toThrow(/different session/i);
    const rich = fixture();
    rich.data.list[0].response_messages[3].meta_data.multi_load.push({ type: "document" });
    expect(() => parseQianwenConversation(rich)).toThrow(/rich answer content/i);
    const source = fixture();
    source.data.list[0].response_messages[2].meta_data.sources.push({ title: "Source" });
    expect(() => parseQianwenConversation(source)).toThrow(/source cards/i);
    const followup = fixture();
    const empty = { mime_type: "paa/iframe", status: "complete", meta_data: { show_type: "", scene: "", exclusive_card_types: [], paas: [], append_msg: { mime_type: "", status: "", content: "", meta_data: { multi_load: [] } } } };
    followup.data.list[0].response_messages.push(empty);
    expect(parseQianwenConversation(followup).messages).toHaveLength(4);
    empty.meta_data.append_msg.content = "Visible extra answer";
    expect(() => parseQianwenConversation(followup)).toThrow(/follow-up content/i);
  });
  it("matches only qianwen.com conversation URLs", () => {
    expect(qianwenAdapter.matches(conversationUrl)).toBe(true);
    expect(qianwenAdapter.matches(`${conversationUrl}/`)).toBe(true);
    expect(qianwenAdapter.matches("https://qianwen.com/")).toBe(false);
    expect(qianwenAdapter.matches(`https://www.qianwen.com/chat/${sessionId}`)).toBe(true);
    expect(qianwenAdapter.matches(`https://chat.qwen.ai/c/${sessionId}`)).toBe(false);
    expect(qianwenAdapter.matches(`https://qianwen.com/chat/${sessionId}/extra`)).toBe(false);
    expect(qianwenAdapter.matches("https://qianwen.com/chat/")).toBe(false);
  });

  it("restores newest-first records to ask order and keeps one text source per turn", () => {
    const result = parseQianwenConversation(fixture());
    expect(result.platform).toBe("qianwen");
    expect(result.id).toBe(sessionId);
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(result.messages.map((message) => message.id)).toEqual([
      "req-fixture-turn-1:user",
      "req-fixture-turn-1:assistant",
      "req-fixture-turn-2:user",
      "req-fixture-turn-2:assistant"
    ]);
    // meta_data.ori_query duplicates the prompt; it must not be appended again.
    expect(result.messages[0].text).toBe("第一轮：帮我写一段中文问候语，并加一个 JavaScript 例子。\n\n开头标记：COPY-QA-START-1");
    expect(result.messages[2].text).toBe("第二轮：请用 Python 写一个快速排序，并解释分区步骤。");
    expect(result.messages[0].text.match(/第一轮/g)).toHaveLength(1);
    expect(result.messages[1].text).toContain("```javascript");
    expect(result.messages[1].text).toContain("你好，${name}！");
    expect(result.messages[3].text).toContain("```python");
    expect(result.messages[3].text.trimEnd().endsWith("COPY-QA-END-2")).toBe(true);
  });

  it("uses only the multi_load body and ignores known UI blocks and follow-up suggestions", () => {
    const [firstUser, firstAnswer, secondUser, secondAnswer] = parseQianwenConversation(fixture()).messages;
    const joined = [firstUser, firstAnswer, secondUser, secondAnswer].map((message) => message.text).join("\n");
    expect(joined).not.toContain("再给一个英文版本");
    expect(joined).not.toContain("能改成迭代版本吗？");
    expect(joined).not.toContain("fixture-survey");
    expect(joined).not.toContain("code_generation");
    expect(joined).not.toContain("inline_action_reply");
    const unbound = fixture();
    unbound.data.list[0].response_messages[3].meta_data.multi_load = [];
    expect(() => parseQianwenConversation(unbound)).toThrow(/unresolved follow-up marker/i);
    const noAnswer = fixture();
    noAnswer.data.list[0].response_messages[3].content = "[[inline_action_reply_1]]";
    expect(() => parseQianwenConversation(noAnswer)).toThrow(/no answer text/i);
  });

  it("rejects unsupported or visibly lossy response structures", () => {
    const unknownMime = fixture();
    record(unknownMime, "req-fixture-turn-2").response_messages[4] = {
      mime_type: "file", sub_type: "attachment", status: "complete", content: "report.pdf"
    };
    expect(() => parseQianwenConversation(unknownMime)).toThrow(/unsupported response blocks \(file\/attachment\)/i);

    const uiWithContent = fixture();
    record(uiWithContent, "req-fixture-turn-1").response_messages[2].content = "Visible reminder";
    expect(() => parseQianwenConversation(uiWithContent)).toThrow(/unexpectedly carries content/i);

    const twoBodies = fixture();
    record(twoBodies, "req-fixture-turn-1").response_messages.push({
      mime_type: "multi_load/iframe", status: "complete", content: "Duplicated answer"
    });
    expect(() => parseQianwenConversation(twoBodies)).toThrow(/2 assistant answer bodies/i);

    const noBody = fixture();
    record(noBody, "req-fixture-turn-2").response_messages = record(noBody, "req-fixture-turn-2")
      .response_messages.filter((message) => message.mime_type !== "multi_load/iframe");
    expect(() => parseQianwenConversation(noBody)).toThrow(/0 assistant answer bodies/i);

    const attachment = fixture();
    record(attachment, "req-fixture-turn-1").request_messages = [
      { mime_type: "text/plain", content: "Look at this", meta_data: {} },
      { mime_type: "file/pdf", content: "report.pdf", meta_data: {} }
    ];
    expect(() => parseQianwenConversation(attachment)).toThrow(/attachments or multi-part prompts are not supported/i);

    const richUser = fixture();
    record(richUser, "req-fixture-turn-1").request_messages[0].mime_type = "text/html";
    expect(() => parseQianwenConversation(richUser)).toThrow(/unsupported user message type/i);
  });

  it("rejects incomplete, errored, unverified or ambiguous records instead of partial output", () => {
    const regenerating = fixture();
    record(regenerating, "req-fixture-turn-2").response_messages[3].status = "generating";
    expect(() => parseQianwenConversation(regenerating)).toThrow(/wait for the answer to finish/i);

    const eventPending = fixture();
    record(eventPending, "req-fixture-turn-1").event = "generating";
    expect(() => parseQianwenConversation(eventPending)).toThrow(/event state "generating"/i);

    const errored = fixture();
    const erroredRecord = record(errored, "req-fixture-turn-1");
    erroredRecord.error_code = 30001;
    erroredRecord.error_msg = "quota";
    expect(() => parseQianwenConversation(errored)).toThrow(/error_code 30001: quota/i);

    const wrongSession = fixture();
    record(wrongSession, "req-fixture-turn-2").session_id = "other-session";
    expect(() => parseQianwenConversation(wrongSession)).toThrow(/more than one session/i);

    const duplicateReq = fixture();
    record(duplicateReq, "req-fixture-turn-2").req_id = "req-fixture-turn-1";
    expect(() => parseQianwenConversation(duplicateReq)).toThrow(/duplicate request ids/i);

    const noTimestamp = fixture();
    delete record(noTimestamp, "req-fixture-turn-2").created_at;
    expect(() => parseQianwenConversation(noTimestamp)).toThrow(/no reliable creation time/i);

    const sameTimestamp = fixture();
    record(sameTimestamp, "req-fixture-turn-2").created_at = 1794218361754;
    expect(() => parseQianwenConversation(sameTimestamp)).toThrow(/identical creation times/i);

    const paged = fixture();
    paged.data.have_next_page = true;
    expect(() => parseQianwenConversation(paged)).toThrow(/have_next_page true/i);

    const missingFlag = fixture();
    delete missingFlag.data.have_next_page;
    expect(() => parseQianwenConversation(missingFlag)).toThrow(/have_next_page undefined/i);

    const apiError = fixture();
    apiError.code = 10001;
    apiError.success = false;
    apiError.msg = "ut";
    expect(() => parseQianwenConversation(apiError)).toThrow(/code 10001 \(ut\)/i);

    expect(() => parseQianwenConversation(null)).toThrow(/empty response body/i);
    expect(() => parseQianwenConversation({})).toThrow(/code undefined/i);
    expect(() => parseQianwenConversation({ code: 0, success: true, data: { have_next_page: false, list: [] } }))
      .toThrow(/no conversation records/i);
  });

  it("requests the verified message list with a throwaway client id and maps transport errors", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => fixture() });
    const storage = { getItem: vi.fn() };
    await expect(qianwenAdapter.extractConversation({ url: conversationUrl, fetch, storage })).resolves.toMatchObject({
      platform: "qianwen",
      id: sessionId
    });
    const [endpoint, options] = fetch.mock.calls[0];
    const url = new URL(endpoint);
    expect(`${url.origin}${url.pathname}`).toBe("https://chat2-api.qianwen.com/api/v1/session/msg/list");
    const params = url.searchParams;
    expect(params.get("session_id")).toBe(sessionId);
    expect(params.get("return_response_messages")).toBe("true");
    expect(params.get("event_filter")).toBe("all");
    expect(params.get("biz_id")).toBe("ai_qwen");
    expect(params.get("page")).toBe("1");
    expect(params.has("nonce")).toBe(false);
    expect(params.has("timestamp")).toBe(false);
    expect(params.get("ut")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(options).toEqual({ credentials: "include", headers: { accept: "application/json" } });
    expect(storage.getItem).not.toHaveBeenCalled();

    await qianwenAdapter.extractConversation({ url: conversationUrl, fetch });
    const secondUt = new URL(fetch.mock.calls[1][0]).searchParams.get("ut");
    expect(secondUt).not.toBe(params.get("ut"));

    const deniedFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(qianwenAdapter.extractConversation({ url: conversationUrl, fetch: deniedFetch }))
      .rejects.toMatchObject({ code: "permission_denied" });

    await expect(qianwenAdapter.extractConversation({ url: "https://qianwen.com/", fetch }))
      .rejects.toMatchObject({ code: "missing_conversation_id" });
  });
});
