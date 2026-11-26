import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatConversation } from "../src/core/format.js";
import { parseDeepSeekConversation } from "../src/platforms/deepseek.js";
import { evidenceFiles, surveyDir } from "./helpers/evidence.js";

const rich = () => JSON.parse(readFileSync(new URL("fixtures/deepseek-rich.json", import.meta.url), "utf8"));

/** A one-message-per-side conversation: the shapes below are the interesting part. */
function single(fragments, role = "ASSISTANT") {
  return {
    data: {
      biz_data: {
        current_message_id: "a1",
        chat_session: { chat_session_id: "session", title: "Synthetic" },
        chat_messages: [
          { message_id: "u1", parent_id: null, role: "USER", fragments: [{ type: "REQUEST", content: "Ask" }] },
          { message_id: "a1", parent_id: "u1", role, fragments }
        ]
      }
    }
  };
}

const reply = (data) => parseDeepSeekConversation(data).messages.at(-1);

describe("DeepSeek rich fragments", () => {
  it("skips reasoning and disclaimer stages", () => {
    const message = reply(single([
      { type: "THINK", content: "Private reasoning", elapsed_secs: 4, references: [], stage_id: 1 },
      { type: "RESPONSE", content: "Visible answer" },
      { type: "TIP", content: "This response is AI-generated, for reference only.", style: "WARNING", hide_on_wip: true }
    ]));
    expect(message.text).toBe("Visible answer");
  });

  it("keeps a reasoning-only assistant turn as an explicit note", () => {
    const message = reply(single([{ type: "THINK", content: "Private reasoning", elapsed_secs: 2 }]));
    expect(message).toEqual({ id: "a1", role: "assistant", text: "[Reasoning only; no reply text]" });
  });

  it("renders the template response the user actually saw", () => {
    const message = reply(single([{ type: "TEMPLATE_RESPONSE", content: "Server busy, try again later." }]));
    expect(message.text).toBe("Server busy, try again later.");
  });

  it("renders the search line and lists only the cited results, in citation order", () => {
    const message = reply(single([
      {
        type: "SEARCH",
        status: "FINISHED",
        content: "Found 3 web pages",
        queries: ["alpha", "beta"],
        results: [
          { url: "https://b.example.org/2", title: "Second", site_name: "Site B", cite_index: 2 },
          { url: "https://a.example.org/1", title: "First", site_name: "Site A", cite_index: 1 },
          { url: "https://c.example.org/3", title: "Uncited", site_name: "Site C", cite_index: 3 }
        ]
      },
      // Cited 2 then 1: the reference order follows the text, not cite_index.
      { type: "RESPONSE", content: "Answer[citation:2] and[citation:1]." }
    ]));
    expect(message.text).toBe(
      "[Web search: alpha · beta]\n\nAnswer ([Site B](https://b.example.org/2)) and ([Site A](https://a.example.org/1))."
    );
    expect(message.references).toEqual([
      { title: "Second", url: "https://b.example.org/2" },
      { title: "First", url: "https://a.example.org/1" }
    ]);
  });

  it("lists no references for a search whose results the reply never cites", () => {
    const message = reply(single([
      {
        type: "SEARCH",
        status: "FINISHED",
        queries: ["alpha"],
        results: [{ url: "https://a.example.org/1", title: "First", cite_index: 1 }]
      },
      { type: "RESPONSE", content: "Answer without sources." }
    ]));
    // The search still happened, so its line stays; its results are not sources.
    expect(message.text).toBe("[Web search: alpha]\n\nAnswer without sources.");
    // No references key at all: the message carries no source list.
    expect(message.references).toBeUndefined();
  });

  it("lists a cited result once even when the reply cites it twice", () => {
    const message = reply(single([
      {
        type: "SEARCH",
        status: "FINISHED",
        queries: [],
        results: [{ url: "https://a.example.org/1", title: "First", cite_index: 1 }]
      },
      { type: "RESPONSE", content: "One[citation:1] two[citation:1]." }
    ]));
    expect(message.references).toEqual([{ title: "First", url: "https://a.example.org/1" }]);
  });

  it("renders a bare search line when the API reports no queries", () => {
    const message = reply(single([
      { type: "SEARCH", status: "FINISHED", content: "Found 1 web page", queries: [], results: [] }
    ]));
    expect(message.text).toBe("[Web search]");
    expect(message.references).toBeUndefined();
  });

  it("keeps only cited http(s) results and dedupes by url", () => {
    const message = reply(single([
      {
        type: "SEARCH",
        status: "FINISHED",
        queries: ["q"],
        results: [
          { url: "https://dup.example.org/x", title: "Original", cite_index: 1 },
          { url: "javascript:alert(1)", title: "Unsafe", cite_index: 2 },
          { url: "https://dup.example.org/x", title: "Duplicate", cite_index: 3 },
          { url: "https://site.example.org/y", cite_index: 4, site_name: "Site Name" }
        ]
      },
      { type: "RESPONSE", content: "A[citation:1] B[citation:2] C[citation:3] D[citation:4]" }
    ]));
    // The unsafe result is cited but dropped; the duplicate URL is listed once.
    expect(message.references).toEqual([
      { title: "Original", url: "https://dup.example.org/x" },
      { title: "Site Name", url: "https://site.example.org/y" }
    ]);
  });

  it("replaces citation markers with a source link and drops unmatched ones", () => {
    const message = reply(single([
      {
        type: "SEARCH",
        status: "FINISHED",
        queries: ["q"],
        results: [
          { url: "https://named.example.org/a", title: "Title A", site_name: "Site A", cite_index: 1 },
          { url: "https://titled.example.org/b", title: "Title B", cite_index: 5 }
        ]
      },
      { type: "RESPONSE", content: "One[citation:1] two[citation:5] unknown[citation:9]." }
    ]));
    expect(message.text).toBe(
      "[Web search: q]\n\nOne ([Site A](https://named.example.org/a)) two ([Title B](https://titled.example.org/b)) unknown."
    );
    expect(message.text).not.toContain("[citation:");
  });

  it("resolves citations from a search fragment listed after the text", () => {
    const message = reply(single([
      { type: "RESPONSE", content: "Late source[citation:1]." },
      {
        type: "SEARCH",
        status: "FINISHED",
        queries: [],
        results: [{ url: "https://late.example.org/x", title: "Late", cite_index: 1 }]
      }
    ]));
    expect(message.text).toBe("Late source ([Late](https://late.example.org/x)).\n\n[Web search]");
  });

  it("renders files by name only and never exposes private handles", () => {
    const message = reply(single([
      {
        type: "FILE",
        files: [
          { id: "f1", file_name: "report.txt", file_size: 12, is_image: false, signed_path: "/file?token=secret", status: "SUCCESS" },
          { id: "f2", file_name: "chart.png", file_size: 34, is_image: true, signed_path: "/file?token=secret" }
        ]
      },
      { type: "RESPONSE", content: "Done" }
    ]));
    expect(message.text).toBe("[File: report.txt]\n\n[Image: chart.png]\n\nDone");
    expect(message.text).not.toMatch(/signed|token|f1|f2|secret/);
  });

  it("keeps the placeholder for fragment types it does not know", () => {
    const message = reply(single([{ type: "MYSTERY_BLOCK", content: "hidden" }]));
    expect(message.text).toBe("[DeepSeek content: MYSTERY_BLOCK]");
  });

  it("formats references through the shared formatter", () => {
    const conversation = parseDeepSeekConversation(rich());
    const text = formatConversation(conversation);
    expect(text).not.toContain("[DeepSeek content");
    expect(text).not.toContain("[citation:");
    expect(text).not.toContain("signed_path");
    expect(text).not.toContain("This response is AI-generated");
    expect(text).not.toContain("Private reasoning");
    expect(text).toContain("[File: report.txt]");
    expect(text).toContain("[Image: chart.png]");
    expect(text).toContain("[Web search: transformer architecture · self attention]");
    expect(text).toContain("[Web search]\n");
    expect(text).toContain("([Example One](https://first.example.org/a))");
    expect(text).toContain("[Source: First source](https://first.example.org/a)");
    expect(text).toContain("[Source: Only source](https://only.example.net/page)");
    // Matching how sources are ordered inside one message.
    expect(text.indexOf("[Source: First source]")).toBeLessThan(text.indexOf("[Source: Second source]"));
  });

  it("preserves every message on the branch, including reasoning-only turns", () => {
    const data = rich();
    data.data.biz_data.chat_messages.splice(2, 0, {
      message_id: "a3",
      parent_id: "a2",
      role: "ASSISTANT",
      fragments: [{ type: "THINK", content: "Private reasoning" }]
    });
    data.data.biz_data.chat_messages.find((message) => message.message_id === "u3").parent_id = "a3";
    const messages = parseDeepSeekConversation(data).messages;
    expect(messages.map((message) => message.id)).toEqual(["u1", "a2", "a3", "u3", "a4"]);
    expect(messages[2].text).toBe("[Reasoning only; no reply text]");
  });
});

// Evidence test: runs the parser over real recorded API responses. The recorded
// payloads are private and live outside the repository, so this only runs when
// `CHATCOPY_EVIDENCE` points at the private evidence root (see
// `tests/helpers/evidence.js`).
const evidenceDir = surveyDir("deepseek");

describe.skipIf(!evidenceFiles(evidenceDir).length)("DeepSeek recorded evidence", () => {
  const files = evidenceFiles(evidenceDir);

  it("has recorded responses to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("copies every recorded conversation without placeholders or private handles", () => {
    const rendered = new Map();
    for (const { index, path } of files) {
      const data = JSON.parse(readFileSync(path, "utf8"));
      let text = "";
      expect(() => { text = formatConversation(parseDeepSeekConversation(data)); }, `conversation ${index}`).not.toThrow();
      rendered.set(index, text);
      expect(text, `conversation ${index}`).not.toContain("[DeepSeek content");
      expect(text, `conversation ${index}`).not.toContain("[citation:");
      expect(text, `conversation ${index}`).not.toContain("signed_path");
      // File handles are signed paths starting with `/file?`; the bare word
      // "signed" can legitimately occur in a reply (song lyrics, for example).
      expect(text, `conversation ${index}`).not.toMatch(/\/file\?/);
    }
    if (rendered.has(16)) expect(rendered.get(16)).toContain("服务器繁忙");
    if (rendered.has(0)) {
      expect(rendered.get(0)).toContain("[Web search");
      expect(rendered.get(0)).toContain("[Source:");
    }
  });

  it("lists only cited results, in the reply's citation order", () => {
    // Every search result in the recordings is counted, and every one that the
    // reply never cited must be missing from its source list.
    let uncited = 0, cited = 0;
    for (const { index, path } of files) {
      const data = JSON.parse(readFileSync(path, "utf8"));
      const conversation = parseDeepSeekConversation(data);
      for (const message of conversation.messages) {
        const fragments = data.data.biz_data.chat_messages.find((item) => item.message_id === message.id)?.fragments || [];
        const text = fragments.filter((f) => f.type === "RESPONSE").map((f) => f.content).join("\n");
        const marked = new Set([...text.matchAll(/\[citation:(\d+)\]/g)].map((match) => Number(match[1])));
        const results = fragments.filter((f) => f.type === "SEARCH").flatMap((f) => f.results || []);
        const total = new Set(results.filter((r) => r.cite_index !== undefined).map((r) => r.url)).size;
        const listed = (message.references || []).length;
        expect(listed, `conversation ${index} message ${message.id}`).toBeLessThanOrEqual(total);
        cited += listed;
        uncited += total - listed;
        // Every listed source is one the reply actually cited.
        for (const reference of message.references || []) {
          const hit = results.find((result) => result.url === reference.url);
          expect(marked.has(hit?.cite_index), `conversation ${index} cites ${reference.url}`).toBe(true);
        }
      }
    }
    expect(uncited).toBeGreaterThan(0);
    expect(cited).toBeGreaterThan(0);
  });
});
