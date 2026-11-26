import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { doubaoAdapter, parseDoubaoConversation } from "../src/platforms/doubao.js";
import { copyCurrentConversation } from "../src/core/copy.js";
import { evidenceFile, evidenceFiles, surveyDir } from "./helpers/evidence.js";

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
    for (const mutate of [m => m.user_type = 3, m => m.status = 1, m => m.content_status = 1, m => m.content_type = 1, m => m.content = "extra", m => m.ext.is_finish = "0", m => m.ext.use_content_block = "0", m => m.content_block[0].block_type = 20000, m => m.content_block[0].is_finish = false, m => m.content_block[0].content.document = "extra", m => m.content_block[0].content.pc_event_block = "extra", m => m.content_block[0].content.text_block.summary = "extra", m => m.content_block[0].content.text_block.text = " ", m => m.content_block[0].extra_info = { visible: "extra" }]) {
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

describe("doubao web-search replies", () => {
  const searchFixture = () => JSON.parse(readFileSync(new URL("fixtures/doubao-search.json", import.meta.url), "utf8"));
  const searchConvId = "70000000000000001";
  // The search reply is the oldest message, so it is the last in the fixture.
  const searchReplyBlocks = (data) => body(data).messages.find((message) => message.content_block?.some((block) => block.block_type === 10025)).content_block;

  it("accepts a message with a prose block plus a 10025 search block", () => {
    const result = parseDoubaoConversation(searchFixture(), searchConvId);
    expect(result.messages).toHaveLength(8);
    expect(result.messages.map((m) => m.role[0]).join("")).toBe("uauauaua");
    // Text comes only from the prose blocks, never from the search card.
    // The fixture walks the API's newest-first order, so index 1 carries the
    // last-written mark.
    expect(result.messages[0].text).toBe("USER_MARK_8".repeat(3));
    expect(result.messages[1].text).toBe("ASSISTANT_MARK_7".repeat(3));
  });

  it("orders messages by numeric index even though the index is a string", () => {
    const result = parseDoubaoConversation(searchFixture(), searchConvId);
    // Ascending index order means the fixture's reverse-written marks appear
    // as 8,7 / 6,5 / 4,3 / 2,1 pairs.
    const texts = result.messages.map((m) => m.text);
    expect(texts[0].startsWith("USER_MARK_8")).toBe(true);
    // The search reply now carries a leading queries line before its prose.
    expect(texts.at(-1).startsWith("[Web search: q1]\n\nASSISTANT_MARK_1")).toBe(true);
    expect(texts.at(-1).match(/ASSISTANT_MARK_1/g)).toHaveLength(3);
  });

  it("lists no sources for a search reply that cites nothing inline", () => {
    // A 10025 search block is the retrieval set, not the reply's sources: the
    // cards only become references once the prose cites them.
    const reply = parseDoubaoConversation(searchFixture(), searchConvId).messages.at(-1);
    expect(reply.text.startsWith("[Web search: q1]")).toBe(true);
    expect(reply.references).toEqual([]);
  });

  it("lists only the search card the prose cites inline, taking the card title", () => {
    const data = searchFixture(), blocks = searchReplyBlocks(data);
    // As in the recorded payloads, a card URL is the citation URL plus
    // tracking parameters, so the title is matched after the same cleanup.
    const card = (url, title) => ({ text_card: { title, url, doc_id: title } });
    blocks.find((block) => block.block_type === 10025).content.search_query_result_block.results = [
      card("https://example.invalid/a?utm=x&f_link_type=1&flow_extra=zz", "Example result"),
      card("https://example.invalid/uncited", "Uncited result")
    ];
    const prose = blocks.find((block) => block.block_type === 10000);
    prose.content.text_block.text = "Cited point";
    prose.meta_info = [{
      type: 2, tag_info: "",
      // Two bytes per ASCII character: the citation sits after "Cited point".
      info: JSON.stringify({ insert_text: "(1)", url: "https://example.invalid/a?utm=x", website_name: "example.invalid", pos: [11] })
    }];
    const reply = parseDoubaoConversation(data, searchConvId).messages.at(-1);
    expect(reply.text).toBe("[Web search: q1]\n\nCited point ([example.invalid](https://example.invalid/a?utm=x))");
    expect(reply.references).toEqual([{ title: "Example result", url: "https://example.invalid/a?utm=x" }]);
  });

  it("falls back to the citation's own website name when no card matches", () => {
    const data = searchFixture(), blocks = searchReplyBlocks(data);
    const prose = blocks.find((block) => block.block_type === 10000);
    prose.content.text_block.text = "Point";
    prose.meta_info = [{
      type: 2, tag_info: "",
      info: JSON.stringify({ insert_text: "(1)", url: "https://other.invalid/page", website_name: "Other Site", pos: [5] })
    }];
    const reply = parseDoubaoConversation(data, searchConvId).messages.at(-1);
    expect(reply.references).toEqual([{ title: "Other Site", url: "https://other.invalid/page" }]);
  });

  it("lists a repeated citation once, in the order the prose cites it", () => {
    const data = searchFixture(), blocks = searchReplyBlocks(data);
    const prose = blocks.find((block) => block.block_type === 10000);
    prose.content.text_block.text = "ABCD";
    prose.meta_info = [
      { type: 2, tag_info: "", info: JSON.stringify({ insert_text: "(1)", url: "https://b.invalid/2", website_name: "Site B", pos: [4] }) },
      { type: 2, tag_info: "", info: JSON.stringify({ insert_text: "(1)", url: "https://a.invalid/1", website_name: "Site A", pos: [2] }) },
      { type: 2, tag_info: "", info: JSON.stringify({ insert_text: "(1)", url: "https://b.invalid/2?flow_extra=zz", website_name: "Site B", pos: [1] }) }
    ];
    const reply = parseDoubaoConversation(data, searchConvId).messages.at(-1);
    expect(reply.references).toEqual([
      { title: "Site B", url: "https://b.invalid/2" },
      { title: "Site A", url: "https://a.invalid/1" }
    ]);
  });

  it("still rejects an unknown block type alongside prose", () => {
    const data = searchFixture();
    data.downlink_body.pull_singe_chain_downlink_body.messages[1].content_block.push({
      block_type: 99999, block_id: "x", parent_id: "0", content: {}, meta_info: [], is_finish: true, extra_info: {}, append_fields: []
    });
    expect(() => parseDoubaoConversation(data, searchConvId)).toThrow(/unverified rich content/);
  });

  it("renders two prose blocks as two paragraphs instead of rejecting the reply", () => {
    const data = searchFixture();
    // The fixture walks newest-first, so messages[0] is the search reply.
    const blocks = data.downlink_body.pull_singe_chain_downlink_body.messages[0].content_block;
    const copy = JSON.parse(JSON.stringify(blocks[0]));
    copy.content.text_block.text = "SECOND_PARAGRAPH";
    copy.block_id = "second";
    blocks.push(copy);
    // The search reply is the oldest message, so it sorts last.
    const text = parseDoubaoConversation(data, searchConvId).messages.at(-1).text;
    // Both prose blocks render in array order, separated by a blank line, and
    // the leading search line still comes first.
    expect(text.startsWith("[Web search: q1]\n\n")).toBe(true);
    expect(text.endsWith("ASSISTANT_MARK_1ASSISTANT_MARK_1ASSISTANT_MARK_1\n\nSECOND_PARAGRAPH")).toBe(true);
  });

  it("rejects a message with only a search block and no prose", () => {
    const data = searchFixture();
    const message = data.downlink_body.pull_singe_chain_downlink_body.messages[1];
    message.content_block = message.content_block.filter((b) => b.block_type === 10025);
    expect(() => parseDoubaoConversation(data, searchConvId)).toThrow(/no content blocks|exactly one prose block/);
  });
});

describe("doubao failure diagnostics", () => {
  it("attaches a content-free shape summary without lengthening the message", async () => {
    const fixture = JSON.parse(readFileSync(new URL("fixtures/doubao-search.json", import.meta.url), "utf8"));
    fixture.downlink_body.pull_singe_chain_downlink_body.has_more = true;
    const { summarizeDoubaoResponse } = await import("../src/platforms/doubao-shape.js");
    const shape = summarizeDoubaoResponse(fixture, "70000000000000001");
    expect(shape.message_count).toBe(8);
    expect(shape.has_more).toBe(true);
    // The summary must never carry conversation text.
    expect(JSON.stringify(shape)).not.toMatch(/USER_MARK|ASSISTANT_MARK/);
    expect(() => parseDoubaoConversation(fixture, "70000000000000001"))
      .toThrow(/paginated/);
  });
});

describe("doubao rich prose blocks", () => {
  const richId = "80000000000000001";
  const richFixture = () => JSON.parse(readFileSync(new URL("fixtures/doubao-rich.json", import.meta.url), "utf8"));
  const replyMessage = (data) => body(data).messages[0];
  const proseBlock = (data) => replyMessage(data).content_block.find((block) => block.block_type === 10000);
  const reply = () => parseDoubaoConversation(richFixture(), richId).messages[1].text;
  const meta = (info) => ({ type: 202, tag_info: "", info: JSON.stringify(info) });
  const image = (main_site_url, img_caption = "图") => ({ type: 1, image: { img_caption, main_site_url, thumb_url: "https://p-sign.invalid/t", full_size_url: ["https://p-sign.invalid/f"] } });

  it("inlines a citation at its byte offset and cleans tracking params", () => {
    const text = reply();
    expect(text).toContain("第一行摘要 ([示例站](https://example.invalid/paper?keep=1))。");
    expect(text).not.toContain("f_link_type");
    expect(text).not.toContain("flow_extra");
  });

  it("inlines an image card on its own paragraph using only the site URL", () => {
    const text = reply();
    expect(text).toContain("\n\n[Image: 表情后的图](https://example.invalid/after-emoji)\n\n");
    expect(text).not.toContain("byteimg");
    expect(text).not.toContain("sign.invalid/t");
  });

  it("inlines a video card with the truncated first caption line and the source", () => {
    const text = reply();
    expect(text).toContain("\n\n[Video: 小节前的视频 · 示例视频源](https://example.invalid/video2)\n\n");
    expect(text).not.toContain("第二行忽略");
  });

  it("writes several media items from one entry as separate lines", () => {
    const text = reply();
    expect(text).toContain("[Image: 示意图一](https://example.invalid/one)\n[Image: image](https://example.invalid/two)\n[Video: 第一条视频说明 · 示例视频源](https://example.invalid/video)");
  });

  it("counts offsets in UTF-8 bytes, not UTF-16 units, so multibyte text stays intact", () => {
    // The emoji entry sits at byte 52 (a UTF-16 index of 50); an off-by-a-codepoint
    // implementation would split the emoji or land mid-character.
    expect(reply()).toContain("[Image: 表情后的图](https://example.invalid/after-emoji)\n\n😀 emoji 之后继续写。");
  });

  it("clamps an offset beyond the end of the text instead of throwing", () => {
    const data = richFixture();
    proseBlock(data).meta_info = [meta({ pos: 999999, scene_type: 1, media: [image("https://example.invalid/end")] })];
    expect(replyText(data).endsWith("[Image: 图](https://example.invalid/end)\n\n")).toBe(true);
  });

  it("snaps an offset that lands inside a multibyte character back to its start", () => {
    const data = richFixture();
    // Byte 53 is the second byte of the 4-byte emoji starting at byte 52.
    proseBlock(data).meta_info = [meta({ pos: 53, scene_type: 1, media: [image("https://example.invalid/snap")] })];
    expect(replyText(data)).toContain("[Image: 图](https://example.invalid/snap)");
    expect(replyText(data)).not.toContain("\ufffd");
  });

  it("prepends the web-search queries line and lists only the cited cards", () => {
    const parsed = parseDoubaoConversation(richFixture(), richId);
    expect(parsed.messages[1].text.startsWith("[Web search: 示例查询一 · 示例查询二]\n\n第一行摘要")).toBe(true);
    // The fixture's only inline citation is not one of its search cards, so its
    // own title is used, and the two uncited cards are not sources.
    expect(parsed.messages[1].references).toEqual([{ title: "示例论文", url: "https://example.invalid/paper?keep=1" }]);
  });

  it("keeps the queries line but drops the references when nothing is cited", () => {
    const data = richFixture();
    proseBlock(data).meta_info = [];
    const reply = parseDoubaoConversation(data, richId).messages[1];
    expect(reply.text.startsWith("[Web search: 示例查询一 · 示例查询二]\n\n")).toBe(true);
    expect(reply.references).toEqual([]);
  });

  it("still rejects an unknown meta_info type or unparsable info", () => {
    for (const entry of [{ type: 3, tag_info: "", info: "{}" }, { type: 202, tag_info: "", info: "not json" }, { type: 2, tag_info: "", info: "{" }]) {
      const data = richFixture();
      proseBlock(data).meta_info = [entry];
      expect(() => parseDoubaoConversation(data, richId)).toThrow(/cannot be copied safely/);
    }
  });

  it("still rejects an unknown media item type", () => {
    const data = richFixture();
    proseBlock(data).meta_info = [meta({ pos: 0, scene_type: 1, media: [{ type: 3, audio: {} }] })];
    expect(() => parseDoubaoConversation(data, richId)).toThrow(/cannot be copied safely/);
  });

  it("skips a non-http citation link but keeps the prose", () => {
    const data = richFixture();
    proseBlock(data).meta_info = [{ type: 2, tag_info: "", info: JSON.stringify({ insert_text: "(site)", pos: [0], url: "javascript:alert(1)" }) }];
    expect(replyText(data)).toContain("第一行摘要。");
    expect(replyText(data)).not.toContain("alert(1)");
  });

  function replyText(data) {
    return parseDoubaoConversation(data, richId).messages[1].text;
  }
});

const richFile = evidenceFile("doubao-rich", "raw.json");

describe.skipIf(!richFile)("doubao rich evidence", () => {
  it("renders the recorded rich reply without leaking signed URLs", () => {
    const data = JSON.parse(readFileSync(richFile, "utf8"));
    const parsed = parseDoubaoConversation(data, "38456425199074818");
    expect(parsed.messages).toHaveLength(2);
    const reply = parsed.messages[1];
    expect(reply.text).toContain("[Web search:");
    expect(reply.text).toContain("([arXiv](https://arxiv.org/html/1706.03762v7))");
    expect(reply.text.match(/\[Image: /g)).toHaveLength(3);
    expect(reply.text.match(/\[Video: /g)).toHaveLength(1);
    expect(reply.text).toContain("抖音");
    expect(reply.text).not.toContain("byteimg");
    expect(reply.text).not.toContain("flow_extra");
    // 29 search cards, but the prose cites only one source inline, so that is
    // the whole reference list. The cited URL matches a card after tracking
    // parameters are stripped, and the card's title is used.
    expect(reply.references).toHaveLength(1);
    expect(reply.references[0].url).toBe("https://arxiv.org/html/1706.03762v7");
  });
});

describe("doubao legacy content_type 1 messages", () => {
  const legacyId = "90000000000000001";
  const legacyFixture = () => JSON.parse(readFileSync(new URL("fixtures/doubao-legacy.json", import.meta.url), "utf8"));
  const legacyMessages = (data) => body(data).messages;
  const parsed = () => parseDoubaoConversation(legacyFixture(), legacyId);

  it("reads prose and search cards out of the JSON content string", () => {
    const result = parsed();
    expect(result.messages.map((m) => m.role[0]).join("")).toBe("uaua");
    expect(result.messages[0].text).toBe("LEGACY_USER_ONE 请问？");
    expect(result.messages[1].text.startsWith("LEGACY_REPLY_ONE 开头。")).toBe(true);
  });

  it("inlines a legacy citation at its UTF-16 offset and cleans its URL", () => {
    const text = parsed().messages[1].text;
    // "第二句" starts at code unit 17 of the synthetic text; an off-by-one
    // implementation (bytes, or a dropped offset) would place it elsewhere.
    expect(text).toBe("LEGACY_REPLY_ONE 开头。 ([Example Site](https://example.invalid/legacy-a))第二句引用来源。收尾。");
  });

  it("lists only the cited legacy search card, taking the card title", () => {
    const references = parsed().messages[1].references;
    // The reply cites legacy-a inline; legacy-b is an uncited search card.
    expect(references).toEqual([{ title: "Legacy Card A", url: "https://example.invalid/legacy-a" }]);
  });

  it("drops the inline marker when a citation has no position but still lists it", () => {
    const reply = parsed().messages[3];
    expect(reply.text).toBe("LEGACY_REPLY_TWO 没有位置。");
    expect(reply.references).toEqual([{ title: "Example Three", url: "https://example.invalid/legacy-c" }]);
  });

  it("lists no legacy references when the reply has cards but cites nothing", () => {
    const data = legacyFixture();
    legacyMessages(data).map((message) => message).filter((message) => message.content_type === 1 && message.ext?.meta_info).forEach((message) => { message.ext.meta_info = "[]"; });
    const result = parseDoubaoConversation(data, legacyId);
    expect(result.messages[1].references).toEqual([]);
    expect(result.messages[3].references).toEqual([]);
  });

  it("accepts content_status 120 as a completed message", () => {
    // The first user message carries content_status 120 in the fixture.
    expect(legacyMessages(legacyFixture())[2].content_status).toBe(120);
    expect(() => parsed()).not.toThrow();
  });

  it("still rejects unknown legacy keys, bad positions and unknown meta types", () => {
    for (const mutate of [
      (m) => m[0].content = JSON.stringify({ text: "x", attachments: [] }),
      (m) => m[0].content = "not json",
      (m) => m[0].content = "",
      (m) => m[0].content = JSON.stringify({ text: " " }),
      (m) => m[1].ext.meta_info = "not json",
      (m) => m[1].ext.meta_info = JSON.stringify([{ type: -5, info: "{}" }]),
      (m) => m[1].ext.meta_info = JSON.stringify([{ type: 2, info: "{}" }]),
      (m) => m[1].ext.meta_info = JSON.stringify([{ type: 2, info: JSON.stringify({ url: "https://example.invalid/x" }) }]),
      (m) => m[1].ext.meta_info = JSON.stringify([{ type: 2, info: JSON.stringify({ url: "https://example.invalid/x", pos: ["1"] }) }]),
      (m) => m[1].content_block = [{ block_type: 10000 }],
      (m) => m[1].ext.use_content_block = "1",
      (m) => m[0].content_status = 121
    ]) {
      const data = legacyFixture(); mutate(legacyMessages(data));
      expect(() => parseDoubaoConversation(data, legacyId)).toThrow();
    }
  });
});

describe("doubao multi-block replies", () => {
  const blockId = "90000000000000001";
  const blockFixture = () => JSON.parse(readFileSync(new URL("fixtures/doubao-blocks.json", import.meta.url), "utf8"));
  const messages = (data) => body(data).messages;
  const parsed = () => parseDoubaoConversation(blockFixture(), blockId);
  const blocksOf = (data, index) => messages(data)[index].content_block;
  const find = (message, blockType) => message.content_block.find((block) => block.block_type === blockType);

  it("renders prose around a document preview in array order", () => {
    const text = parsed().messages[1].text;
    expect(text).toContain("BLOCK_PROSE_ONE  ([Block Site](https://example.invalid/block-a))第一段。\n\n[Doubao document: SYNTHETIC_DOC_TITLE]\n\n");
    expect(text).toContain("\n\n(Preview only. Open the document in Doubao for the full text.)\n\nBLOCK_PROSE_TWO 第二段。");
    expect(text.startsWith("[Web search: BLOCK QUERY]\n\n")).toBe(true);
  });

  it("accepts a reply that is only a document preview", () => {
    const data = blockFixture();
    messages(data)[1].content_block = blocksOf(data, 1).filter((block) => block.block_type !== 10000);
    const text = parseDoubaoConversation(data, blockId).messages[1].text;
    // The search line still leads; the preview is the only body block.
    expect(text.startsWith("[Web search: BLOCK QUERY]\n\n[Doubao document: SYNTHETIC_DOC_TITLE]\n\n")).toBe(true);
    expect(text).not.toContain("BLOCK_PROSE");
  });

  it("quotes an earlier reply above the user's prose", () => {
    expect(parsed().messages[2].text).toBe("> QUOTED_LINE_ONE\n> QUOTED_LINE_TWO\n\nBLOCK_USER_TWO 继续。");
  });

  it("skips the AI disclaimer tip and the suggested follow-up questions", () => {
    const reply = parsed().messages[3];
    expect(reply.text).toBe("[Web search: SYNTHETIC QUERY]\n\nBLOCK_REPLY_TWO 带搜索。");
    expect(reply.text).not.toContain("SYNTHETIC DISCLAIMER");
    expect(reply.text).not.toContain("SYNTHETIC_QUESTION");
  });

  it("still rejects unknown block types, tips types and malformed skip blocks", () => {
    for (const mutate of [
      (m) => m[1].content_block.push({ ...JSON.parse(JSON.stringify(m[1].content_block[0])), block_type: 99999 }),
      (m) => find(m[3], 10053).content.tips_block.type = 2,
      (m) => find(m[3], 10053).content.tips_block.text = 5,
      (m) => find(m[3], 10053).content.extra = 1,
      (m) => find(m[3], 2002).content.suggest_block.suggestions = "x",
      (m) => find(m[1], 10030).content.artifact_block.status = 1,
      (m) => find(m[1], 10030).content.artifact_block.title = "",
      (m) => find(m[1], 10030).content.artifact_block.extra = "x",
      (m) => find(m[2], 10056).content.reference_block.type = 5,
      (m) => find(m[2], 10056).content.reference_block.text.sub_index = 1,
      (m) => find(m[2], 10056).content.reference_block.text.text = " ",
      (m) => find(m[3], 10053).is_finish = false
    ]) {
      const data = blockFixture(); mutate(messages(data));
      expect(() => parseDoubaoConversation(data, blockId)).toThrow();
    }
  });

  it("rejects two quoted references and two search blocks", () => {
    for (const blockType of [10056, 10025]) {
      const data = blockFixture();
      const blocks = blocksOf(data, blockType === 10056 ? 2 : 3);
      const source = blocks.find((block) => block.block_type === blockType);
      blocks.push(JSON.parse(JSON.stringify(source)));
      expect(() => parseDoubaoConversation(data, blockId)).toThrow(/require additional verification/);
    }
  });

  it("rejects a reply whose content string repeats different blocks", () => {
    const data = blockFixture();
    messages(data)[1].content = JSON.stringify([{ block_type: 10000 }, { block_type: 10025 }]);
    expect(() => parseDoubaoConversation(data, blockId)).toThrow(/unverified content format/);
  });

  it("accepts a content string that mirrors the blocks exactly", () => {
    const data = blockFixture();
    messages(data)[1].content = JSON.stringify(blocksOf(data, 1).map((block) => ({ block_type: block.block_type })));
    expect(() => parseDoubaoConversation(data, blockId)).not.toThrow();
  });
});

const surveyFiles = evidenceFiles(surveyDir("doubao"), { withUrl: true }).filter((entry) => entry.urlPath && entry.index < 25);
describe.skipIf(!surveyFiles.length)("doubao survey evidence", () => {
  it("parses every recorded conversation without leaking raw placeholders", async () => {
    const { formatConversation } = await import("../src/core/format.js");
    const failures = [], rejected = [];
    for (const { index, path: raw, urlPath } of surveyFiles) {
      const conversationId = readFileSync(urlPath, "utf8").trim().match(/\/chat\/(\d+)/)?.[1];
      let formatted;
      try {
        formatted = formatConversation(parseDoubaoConversation(JSON.parse(readFileSync(raw, "utf8")), conversationId));
      } catch (error) {
        rejected.push(index);
        continue;
      }
      // Source URLs can legitimately contain a literal `undefined` query value,
      // so only message text is checked for the placeholder.
      const text = formatted.split("\n").filter((line) => !/^\[Source: /.test(line)).join("\n");
      for (const needle of ["byteimg", "flow_extra", "[object Object]", "undefined"]) {
        if (text.includes(needle)) failures.push(`${index}: found ${needle}`);
      }
      if (index === 4 && !formatted.includes("[Doubao document:")) failures.push("4: missing document preview");
    }
    expect(failures).toEqual([]);
    // Conversation 1 is a regenerated branch: its messages span two sections,
    // so the active chain is genuinely ambiguous and still throws.
    expect(rejected).toEqual([1]);
  });

  it("lists a search reply's sources only when its own prose cites them", () => {
    let repliesWithCards = 0, repliesWithoutSources = 0, totalSources = 0;
    for (const { index, path: raw, urlPath } of surveyFiles) {
      if (index === 1) continue; // rejected above
      const conversationId = readFileSync(urlPath, "utf8").trim().match(/\/chat\/(\d+)/)?.[1];
      const data = JSON.parse(readFileSync(raw, "utf8"));
      const conversation = parseDoubaoConversation(data, conversationId);
      const messages = body(data).messages;
      for (const [position, message] of conversation.messages.entries()) {
        const record = messages.find((item) => item.message_id === message.id);
        const blocks = record?.content_block || [];
        const hasCards = blocks.some((block) => block.block_type === 10025) ||
          (record?.content_type === 1 && /search_references/.test(record.content || ""));
        if (!hasCards) continue;
        repliesWithCards += 1;
        totalSources += message.references.length;
        if (!message.references.length) repliesWithoutSources += 1;
        // Every listed source is a citation the reply rendered inline, and the
        // list is deduplicated by URL.
        const urls = message.references.map((reference) => reference.url);
        expect(new Set(urls).size, `conversation ${index} message ${position}`).toBe(urls.length);
        const inline = [...message.text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((match) => match[1]);
        for (const reference of message.references) {
          expect(inline, `conversation ${index} cites ${reference.url}`).toContain(reference.url);
        }
      }
    }
    expect(repliesWithCards).toBeGreaterThan(0);
    // Real replies carry search cards they never cite inline.
    expect(repliesWithoutSources).toBeGreaterThan(0);
    expect(totalSources).toBeGreaterThan(0);
  });
});
