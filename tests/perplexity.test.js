import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { formatConversation } from "../src/core/format.js";
import { parsePerplexityConversation, perplexityAdapter } from "../src/platforms/perplexity.js";

const fixture = () => JSON.parse(readFileSync(new URL("fixtures/perplexity.json", import.meta.url), "utf8"));
const conversationId = "dddddddd-0000-4000-8000-00000000000d";
const conversationUrl = `https://www.perplexity.ai/session/${conversationId}`;
const THREAD_QUERY = "with_parent_info=true&with_schematized_response=true&version=2.18&source=default&limit=20&offset=0&from_first=false&with_first_entry=true&with_latest_entry=false&supported_block_use_cases=answer_modes&supported_block_use_cases=media_items&supported_block_use_cases=inline_entity_cards&supported_block_use_cases=place_widgets&supported_block_use_cases=finance_widgets&supported_block_use_cases=news_widgets&supported_block_use_cases=shopping_widgets&supported_block_use_cases=search_result_widgets&supported_block_use_cases=inline_images&supported_block_use_cases=inline_assets&supported_block_use_cases=placeholder_cards&supported_block_use_cases=diff_blocks&supported_block_use_cases=entity_group_v2&supported_block_use_cases=refinement_filters&supported_block_use_cases=canvas_mode&supported_block_use_cases=maps_preview&supported_block_use_cases=answer_tabs&supported_block_use_cases=preserve_latex&supported_block_use_cases=in_context_suggestions&supported_block_use_cases=pending_followups&supported_block_use_cases=inline_claims&supported_block_use_cases=unified_assets&supported_block_use_cases=workflow_steps&supported_block_use_cases=workflow_widgets&supported_block_use_cases=navigation_results&supported_block_use_cases=background_agents";

const assistantOf = (messages) => messages.filter((message) => message.role === "assistant").map((message) => message.text);
const userOf = (messages) => messages.filter((message) => message.role === "user").map((message) => message.text);

describe("Perplexity adapter", () => {
  it("requires the observed payload nesting and rejects ambiguous or unhandled visible content", () => {
    const misplaced = fixture();
    const item = misplaced.entries[0].blocks[1].workflow_block.steps[0].items[0];
    item.text_payload = item.payload.text_payload;
    delete item.payload;
    expect(() => parsePerplexityConversation(misplaced)).toThrow(/text payload/i);
    const duplicate = fixture();
    duplicate.entries.push(duplicate.entries[0]);
    expect(() => parsePerplexityConversation(duplicate)).toThrow(/duplicated/i);
    const different = fixture();
    different.entries[1].context_uuid = "other-context";
    expect(() => parsePerplexityConversation(different)).toThrow(/ambiguous/i);
    const unknown = fixture();
    unknown.entries[0].blocks.push({ intended_usage: "attachment" });
    expect(() => parsePerplexityConversation(unknown)).toThrow(/unsupported content block/i);
    const preview = fixture();
    preview.entries[0].blocks[2].answer_tabs_block.modes[1].has_preview = true;
    expect(() => parsePerplexityConversation(preview)).toThrow(/answer tab content/i);
    expect(() => parsePerplexityConversation(fixture(), "different-session")).toThrow(/different conversation/i);
  });
  it("matches only a saved Perplexity /session conversation URL", () => {
    expect(perplexityAdapter.matches(conversationUrl)).toBe(true);
    expect(perplexityAdapter.matches(`${conversationUrl}/`)).toBe(true);
    expect(perplexityAdapter.matches("https://www.perplexity.ai/")).toBe(false);
    expect(perplexityAdapter.matches("https://www.perplexity.ai/discover")).toBe(false);
    expect(perplexityAdapter.matches(`https://perplexity.ai/session/${conversationId}`)).toBe(true);
    expect(perplexityAdapter.matches("https://www.perplexity.ai/session/abc")).toBe(false);
    expect(perplexityAdapter.matches(`${conversationUrl}/extra`)).toBe(false);
    expect(perplexityAdapter.matches("https://www.perplexity.ai/search/copy-qa-fixture")).toBe(false);
    expect(perplexityAdapter.matches("https://example.com/session/abc")).toBe(false);
  });

  it("extracts five turns in entries order, not marker order", () => {
    const { messages, platform, title } = parsePerplexityConversation(fixture(), conversationId);
    expect(platform).toBe("perplexity");
    expect(title).toBe("Fixture conversation");
    expect(messages).toHaveLength(10);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant"]);
    // entries are stored T1, T2, T4, T3, T5: the transcript must follow the API order.
    expect(userOf(messages).map((text) => text.match(/\[COPY-QA-T(\d)\]/)[1])).toEqual(["1", "2", "4", "3", "5"]);
    expect(assistantOf(messages).map((text) => text.match(/\[COPY-QA-A(\d)\]/)[1])).toEqual(["1", "2", "4", "3", "5"]);
    expect(userOf(messages)[0]).toBe("[COPY-QA-T1] 请列出三种常见的排序算法，并说明最坏时间复杂度。");
  });

  it("keeps Chinese body, Markdown table and fenced code intact", () => {
    const messages = parsePerplexityConversation(fixture()).messages;
    const first = assistantOf(messages)[0];
    expect(first).toContain("| 快速排序 | O(n²) |");
    expect(first).toContain("```python\ndef bubble(values):");
    expect(first.endsWith("[COPY-QA-END-A1]")).toBe(true);
    expect(assistantOf(messages)[2]).toContain("```python\ndef lower_bound(values, target):");
    expect(userOf(messages)[4]).toBe("[COPY-QA-T5] 总结以上内容，用列表形式给出三点结论。");
  });

  it("uses the full text once per answer instead of appending chunks", () => {
    const data = fixture();
    const payload = data.entries[0].blocks.find((block) => block.intended_usage === "workflow_root").workflow_block.steps[0].items[0].payload.text_payload;
    expect(payload.chunks.join("")).toBe(payload.text);
    const text = assistantOf(parsePerplexityConversation(data).messages)[0];
    expect(text).toBe(payload.text.trim());
    expect(text.split("[COPY-QA-A1]").length - 1).toBe(1);
  });

  it("formats into a role-labelled transcript", () => {
    const transcript = formatConversation(parsePerplexityConversation(fixture()));
    expect(transcript.startsWith("User:\n[COPY-QA-T1]")).toBe(true);
    expect(transcript).toContain("\n\n---\n\nPerplexity:\n[COPY-QA-A1]");
    expect(transcript.trimEnd().endsWith("[COPY-QA-END-A5]")).toBe(true);
  });

  it("rejects a truncated answer instead of copying it", () => {
    const data = fixture();
    const payload = data.entries[1].blocks[0].workflow_block.steps[0].items[0].payload.text_payload;
    payload.chunks.push(" trailing fragment");
    expect(() => parsePerplexityConversation(data)).toThrow(/chunks that do not match/i);
    expect(() => parsePerplexityConversation(data)).toThrowError(expect.objectContaining({ code: "invalid_response" }));
  });

  it("rejects a streaming or unfinished answer", () => {
    const streaming = fixture();
    streaming.entries[0].blocks.find((block) => block.intended_usage === "workflow_root")
      .workflow_block.steps[0].items[0].payload.text_payload.is_streaming = true;
    expect(() => parsePerplexityConversation(streaming)).toThrow(/unfinished/i);

    const running = fixture();
    running.entries[2].blocks[0].workflow_block.status = "WORKFLOW_RUNNING";
    expect(() => parsePerplexityConversation(running)).toThrow(/WORKFLOW_RUNNING/);

    const partial = fixture();
    partial.entries[3].status = "STREAMING";
    expect(() => parsePerplexityConversation(partial)).toThrow(/STREAMING/);
  });

  it("rejects paginated responses because later messages could be missing", () => {
    const hasNext = fixture();
    hasNext.has_next_page = true;
    expect(() => parsePerplexityConversation(hasNext)).toThrow(/paginated/i);

    const cursor = fixture();
    cursor.next_cursor = "cursor-fixture";
    expect(() => parsePerplexityConversation(cursor)).toThrow(/paginated/i);

    const latest = fixture();
    latest.latest_entry = { uuid: "aaaaaaaa-0000-4000-8000-000000000009" };
    expect(() => parsePerplexityConversation(latest)).toThrow(/newer entry/i);
  });

  it("rejects unknown first entry, forks, and background entries", () => {
    const missingFirst = fixture();
    delete missingFirst.first_entry;
    expect(() => parsePerplexityConversation(missingFirst)).toThrow(/first conversation entry/i);

    const mismatchedFirst = fixture();
    mismatchedFirst.first_entry.uuid = "aaaaaaaa-0000-4000-8000-000000000002";
    expect(() => parsePerplexityConversation(mismatchedFirst)).toThrow(/does not match/i);

    const fork = fixture();
    fork.thread_metadata.parent_info = { uuid: "parent-fixture" };
    expect(() => parsePerplexityConversation(fork)).toThrow(/fork/i);

    const background = fixture();
    background.background_entries = [{ uuid: "bg-fixture", query_str: "branch question" }];
    expect(() => parsePerplexityConversation(background)).toThrow(/background entries/i);
  });

  it("rejects unknown workflow items and non-answer visible content", () => {
    const unknownItem = fixture();
    unknownItem.entries[0].blocks.find((block) => block.intended_usage === "workflow_root")
      .workflow_block.steps[0].items.push({ type: "WORKFLOW_ITEM_IMAGE", variant: "answer" });
    expect(() => parsePerplexityConversation(unknownItem)).toThrow(/unsupported step items/i);

    const wrongVariant = fixture();
    wrongVariant.entries[1].blocks[0].workflow_block.steps[0].items[0].variant = "sources";
    expect(() => parsePerplexityConversation(wrongVariant)).toThrow(/unsupported step 0 item 0 variant/i);

    const missingWorkflow = fixture();
    missingWorkflow.entries[4].blocks = [];
    expect(() => parsePerplexityConversation(missingWorkflow)).toThrow(/workflow_root blocks/i);
  });

  it("rejects malformed or empty responses", () => {
    expect(() => parsePerplexityConversation({})).toThrow(/invalid_response|status/i);
    expect(() => parsePerplexityConversation(null)).toThrow(/empty response/i);
    const failed = fixture();
    failed.status = "error";
    expect(() => parsePerplexityConversation(failed)).toThrow(/status "error"/i);
    const noEntries = fixture();
    noEntries.entries = [];
    noEntries.first_entry = { uuid: "aaaaaaaa-0000-4000-8000-000000000001" };
    expect(() => parsePerplexityConversation(noEntries)).toThrow(/no conversation entries/i);
    const noQuery = fixture();
    noQuery.entries[0].query_str = "   ";
    expect(() => parsePerplexityConversation(noQuery)).toThrow(/no user query/i);
  });

  it("requests the observed thread endpoint with same-origin cookies only", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => fixture() });
    await expect(perplexityAdapter.extractConversation({ url: conversationUrl, fetch })).resolves.toMatchObject({
      platform: "perplexity",
      id: "cccccccc-0000-4000-8000-00000000000c"
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `https://www.perplexity.ai/rest/thread/${conversationId}?${THREAD_QUERY}`,
      { credentials: "include", headers: { accept: "application/json" } }
    );
    const [, options] = fetch.mock.calls[0];
    expect(JSON.stringify(options)).not.toMatch(/authorization|cookie|token/i);
  });

  it("maps authentication and API failures", async () => {
    for (const [status, code] of [[401, "not_signed_in"], [403, "permission_denied"], [500, "api_unavailable"]]) {
      const fetch = vi.fn().mockResolvedValue({ ok: false, status });
      await expect(perplexityAdapter.extractConversation({ url: conversationUrl, fetch })).rejects.toMatchObject({ code });
    }
  });

  it("requires an open conversation URL", async () => {
    const fetch = vi.fn();
    await expect(perplexityAdapter.extractConversation({ url: "https://www.perplexity.ai/", fetch }))
      .rejects.toMatchObject({ code: "missing_conversation_id" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
