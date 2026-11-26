import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseClaudeConversation } from "../src/platforms/claude.js";
import { formatConversation } from "../src/core/format.js";
import { parseKnowledgeSources, parseSearchSources, renderClaudeBlocks, widgetText } from "../src/platforms/claude-rich.js";
import { evidenceFile, evidenceFiles, surveyDir } from "./helpers/evidence.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), "utf8"));

const FORBIDDEN = [
  "<script",
  "function",
  "getElementById",
  "stroke",
  "viewBox",
  "Unsupported content: tool",
  "Content rendered and shown"
];

function expectNoLeak(text) {
  for (const token of FORBIDDEN) expect(text).not.toContain(token);
}

const expectedRich = `Let me search and draw it.

[Web search: self attention explained]

[Web search: multi-head attention intuition]

Sources:
- [Attention Is All You Need](https://arxiv.org/abs/1706.03762)
- [The Illustrated Transformer](https://jalammar.github.io/illustrated-transformer/)

Sources:
- [Attention Visualizer](https://bbycroft.net/llm)

[Web search: attention benchmark]

Sources:
- [Attention benchmark leaderboard](https://papers.example/attention)

[Interactive visual: attention flow demo]
Attention flow demo heading
Attention arcs
Arcs from query to keys.
Query word
Key word
Thicker arcs mean higher weight.

\`\`\`python
print('hello')
\`\`\`

[Tool used: mcp__unknown__thing]

[Tool used: mcp__broken__thing]

[Tool error: mcp__broken__thing]

[Files: quarterly-plan, budget]

[Tool used: Read]

[Image]

[Image]

[Unsupported content: web page]

Attention weighs every key against the query.`;

describe("Claude rich content", () => {
  it("renders tool blocks, searches, visuals and artefacts as exact Markdown", () => {
    const result = parseClaudeConversation(fixture("claude-rich"));
    expect(result.messages).toEqual([
      { role: "user", text: "Explain attention and show me a diagram." },
      { role: "assistant", text: expectedRich }
    ]);
    expectNoLeak(result.messages[1].text);
  });

  it("skips hidden tool pairs and thinking blocks entirely", () => {
    const data = fixture("claude-rich");
    const text = renderClaudeBlocks(data.chat_messages[1].content);
    expect(text).not.toContain("INTERNAL DOCS");
    expect(text).not.toContain("Internal plan");
    expect(text).not.toContain("read me");
  });

  it("keeps text blocks verbatim and unsupported unknown block types", () => {
    const text = renderClaudeBlocks([
      { type: "text", text: "line one\n\n- bullet  \nkeeps spacing" },
      { type: "web_page", url: "https://example.com" },
      { type: "some_future_thing" }
    ]);
    expect(text).toBe("line one\n\n- bullet\nkeeps spacing\n\n[Unsupported content: web page]\n\n[Unsupported content: some future thing]");
  });

  it("renders attachments with today's placeholder behaviour", () => {
    expect(renderClaudeBlocks([{ type: "image" }, { type: "document", file_name: "notes.pdf" }])).toBe("[Image]\n\n[Attachment: notes.pdf]");
  });

  it("lists presented file names only and drops the present_files tool_use line", () => {
    const text = renderClaudeBlocks([
      { type: "tool_use", id: "pf1", name: "present_files", input: { filepaths: ["/mnt/user-data/outputs/report.md"] } },
      {
        type: "tool_result",
        name: "present_files",
        tool_use_id: "pf1",
        is_error: false,
        content: [
          { type: "local_resource", name: "report", file_path: "/mnt/user-data/outputs/report.md", mime_type: "text/markdown" },
          { type: "local_resource", name: "notes", file_path: "/mnt/user-data/outputs/notes.txt", mime_type: "text/plain" },
          { type: "local_resource", name: "report", file_path: "/mnt/user-data/outputs/report.md", mime_type: "text/markdown" },
          { type: "local_resource", name: "   ", file_path: "/mnt/user-data/outputs/unnamed.md", mime_type: "text/markdown" }
        ]
      }
    ]);
    expect(text).toBe("[Files: report, notes, unnamed.md]");
    expect(text).not.toContain("[Tool used: present_files]");
    expect(text).not.toContain("file_path");
    expect(text).not.toContain("/mnt/");
  });

  it("drops a present_files result with no local resources instead of inventing files", () => {
    const text = renderClaudeBlocks([
      { type: "tool_use", id: "pf2", name: "present_files", input: { filepaths: [] } },
      { type: "tool_result", name: "present_files", tool_use_id: "pf2", is_error: false, content: [{ type: "text", text: "No files." }] }
    ]);
    expect(text).toBe("");
    expect(text).not.toContain("[Files:");
  });

  it("renders one [Image] per image part in a tool result and no image URLs", () => {
    const text = renderClaudeBlocks([
      { type: "tool_use", id: "r1", name: "Read", input: { path: "/mnt/user-data/uploads/chart.png" } },
      {
        type: "tool_result",
        name: "Read",
        tool_use_id: "r1",
        is_error: false,
        content: [
          { type: "text", text: "[Image source: /tmp/claude-tool-results/abc.png]" },
          { type: "image", file_uuid: "11111111-1111-1111-1111-111111111111", preview_url: "https://preview.example/a.png", thumbnail_url: "https://preview.example/a-thumb.png" },
          { type: "image", file_uuid: "22222222-2222-2222-2222-222222222222", preview_url: "https://preview.example/b.png", thumbnail_url: "https://preview.example/b-thumb.png" }
        ]
      }
    ]);
    expect(text).toBe("[Tool used: Read]\n\n[Image]\n\n[Image]");
    expect(text).not.toContain("preview_url");
    expect(text).not.toContain("https://preview");
    // Result text stays unrendered, as before, so image source paths never leak.
    expect(text).not.toContain("Image source");
    expect(text).not.toContain("/tmp/");
    expect(text).not.toContain("11111111");
  });

  it("keeps plain text tool results unrendered", () => {
    const text = renderClaudeBlocks([
      { type: "tool_use", id: "t1", name: "mcp__unknown__result", input: { arg: 1 } },
      { type: "tool_result", name: "mcp__unknown__result", tool_use_id: "t1", is_error: false, content: [{ type: "text", text: "raw payload" }] }
    ]);
    expect(text).toBe("[Tool used: mcp__unknown__result]");
  });

  it("marks a failed web search instead of listing sources", () => {
    const text = renderClaudeBlocks([
      { type: "tool_use", id: "s1", name: "WebSearch", input: { query: "nothing found" } },
      { type: "tool_result", name: "WebSearch", tool_use_id: "s1", is_error: true, content: [{ type: "text", text: "Title\nhttps://example.com/x" }] }
    ]);
    expect(text).toBe("[Web search: nothing found]\n\n[Web search failed]");
  });

  it("skips internal token_budget blocks instead of reporting them as unsupported", () => {
    const text = renderClaudeBlocks([
      { type: "token_budget", start_timestamp: "2026-01-01T00:00:00Z", stop_timestamp: "2026-01-01T00:00:01Z" },
      { type: "text", text: "Answer after a budget block." },
      { type: "token_budget", start_timestamp: "2026-01-01T00:00:02Z", stop_timestamp: "2026-01-01T00:00:03Z" }
    ]);
    expect(text).toBe("Answer after a budget block.");
    expect(text).not.toContain("Unsupported content");
    expect(text).not.toContain("token budget");
  });

  it("renders Claude.ai's lowercase web_search with knowledge sources exactly like WebSearch", () => {
    const text = renderClaudeBlocks([
      { type: "tool_use", id: "ws1", name: "web_search", input: { query: "rust async runtime", mode: "standard" } },
      {
        type: "tool_result",
        name: "web_search",
        tool_use_id: "ws1",
        is_error: false,
        content: [
          { type: "knowledge", title: "Tokio tutorial", url: "https://tokio.rs/tokio/tutorial", metadata: { site_name: "tokio.rs", site_domain: "tokio.rs" }, is_missing: false },
          { type: "knowledge", title: "example.org", url: "https://example.org/async", metadata: { site_name: "example" }, is_missing: false },
          { type: "knowledge", title: "Missing page", url: "https://gone.example/x", metadata: {}, is_missing: true },
          { type: "knowledge", title: "Bad scheme", url: "ftp://files.example/y", metadata: {}, is_missing: false },
          { type: "knowledge", title: "Tokio tutorial", url: "https://tokio.rs/tokio/tutorial", metadata: {}, is_missing: false }
        ]
      }
    ]);
    expect(text).toBe(
      "[Web search: rust async runtime]\n\nSources:\n- [Tokio tutorial](https://tokio.rs/tokio/tutorial)\n- [example.org](https://example.org/async)"
    );
    expect(text).not.toContain("[Tool used: web_search]");
  });

  it("falls back to site_name and skips non-knowledge parts for web_search results", () => {
    expect(
      parseKnowledgeSources({
        content: [
          { type: "text", text: "ignored" },
          { type: "knowledge", url: "https://news.example/a", metadata: { site_name: "news.example" } },
          { type: "knowledge", url: "", title: "no url" },
          null
        ]
      })
    ).toEqual([{ title: "news.example", url: "https://news.example/a" }]);
    expect(parseKnowledgeSources({ content: "plain string" })).toEqual([]);
  });

  it("marks a failed lowercase web_search instead of listing sources", () => {
    const text = renderClaudeBlocks([
      { type: "tool_use", id: "ws2", name: "web_search", input: { query: "nothing found" } },
      { type: "tool_result", name: "web_search", tool_use_id: "ws2", is_error: true, content: [{ type: "knowledge", title: "A", url: "https://a.example/1" }] }
    ]);
    expect(text).toBe("[Web search: nothing found]\n\n[Web search failed]");
  });

  it("skips a hidden lowercase web_search pair like any other hidden tool", () => {
    const text = renderClaudeBlocks([
      { type: "tool_use", id: "ws3", name: "web_search", hidden_in_chat: true, input: { query: "internal probe" } },
      { type: "tool_result", name: "web_search", tool_use_id: "ws3", content: [{ type: "knowledge", title: "X", url: "https://x.example/1" }] }
    ]);
    expect(text).toBe("");
  });

  it("parses only well-formed title/url pairs and drops duplicates", () => {
    const sources = parseSearchSources({
      content: [{ type: "text", text: "Alpha\nhttps://a.example/1\n\nno url here\nhttps://b.example/2\n\nAlpha\nhttps://a.example/1\n\nBeta\nftp://ignored.example/3" }]
    });
    expect(sources).toEqual([
      { title: "Alpha", url: "https://a.example/1" },
      { title: "no url here", url: "https://b.example/2" }
    ]);
  });

  it("extracts only static widget text in document order, deduplicated", () => {
    const lines = widgetText(
      "<h2 class=sr-only>Screen reader heading</h2><svg viewBox=\"0 0 1 1\"><title>Chart title</title><desc>Chart description</desc>" +
        "<text>Shared</text><text>Shared</text><path d=\"M0 0 L9 9\" stroke=\"red\"/></svg>" +
        "<p>Visible caption</p><style>.a{stroke:red}</style><script>const a=1;</script><button>Action</button>"
    );
    expect(lines).toEqual(["Screen reader heading", "Chart title", "Chart description", "Shared", "Visible caption", "Action"]);
    for (const line of lines) {
      expect(line).not.toContain("stroke");
      expect(line).not.toContain("M0 0");
    }
  });

  it("never renders a widget title or script when the widget is empty", () => {
    const text = renderClaudeBlocks([{ type: "tool_use", id: "w", name: "mcp__visualize__show_widget", input: { title: "empty_widget", widget_code: "" } }]);
    expect(text).toBe("[Interactive visual: empty widget]");
  });

  it("leaves the existing Claude fixture output unchanged", () => {
    const result = parseClaudeConversation(fixture("claude"));
    expect(result.messages).toEqual([
      { role: "user", text: "Hello\n\n[Attachment: notes.pdf]" },
      { role: "assistant", text: "Current branch" }
    ]);
  });
});

const richFile = evidenceFile("claude-rich", "conversation.json");

describe("Claude rich evidence", () => {
  it.skipIf(!richFile)("renders the real conversation without leaking code", () => {
    const data = JSON.parse(readFileSync(richFile, "utf8"));
    const result = parseClaudeConversation(data);
    const text = result.messages.map((message) => message.text).join("\n\n");
    expectNoLeak(text);
    expect(text).not.toContain("sendPrompt");
    expect(text).toContain("[Web search:");
    expect(text).toContain("Sources:");
    expect(text).toContain("[Interactive visual: transformer self attention explorer]");
    expect(text).toContain("[Interactive visual: transformer block architecture]");
    expect(text).toContain("The dashed lines are residual connections");
    expect(text).toContain("](https://");
    expect(text).toContain("Self-attention arcs");
    expect(text).toContain("Feed-forward network");
  });
});

// Optional sweep over captured raw API responses. The files are private survey
// data and are never committed; only aggregate facts are used.
const survey = surveyDir("claude");

// `/mnt/...` paths a human or the assistant typed into a text block are part of
// the conversation itself; only tool-result paths are private plumbing.
function typedPathCount(data) {
  let count = 0;
  for (const message of data.chat_messages || []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block && typeof block.text === "string") count += (block.text.match(/\/mnt\//g) || []).length;
    }
    if (typeof message.text === "string") count += (message.text.match(/\/mnt\//g) || []).length;
  }
  return count;
}

describe("Claude survey evidence", () => {
  const files = evidenceFiles(survey);
  it.skipIf(!files.length)("renders every captured conversation without placeholders or script leaks", () => {
    const leaks = [];
    let sawFiles = false;
    for (const { file, path } of files) {
      const data = JSON.parse(readFileSync(path, "utf8"));
      let text;
      try {
        text = formatConversation(parseClaudeConversation(data));
      } catch (error) {
        leaks.push(`${file}: threw ${error.message}`);
        continue;
      }
      for (const token of ["Unsupported content", "[Tool used: web_search]", "<script"]) {
        if (text.includes(token)) leaks.push(`${file}: contains ${token}`);
      }
      for (const token of ["file_path", "preview_url"]) {
        if (text.includes(token)) leaks.push(`${file}: leaks ${token}`);
      }
      const renderedPaths = (text.match(/\/mnt\//g) || []).length;
      if (renderedPaths > typedPathCount(data)) leaks.push(`${file}: leaks /mnt/ from tool data`);
      if (text.includes("[Files:")) sawFiles = true;
      if (file === "24.raw.json") {
        if (!text.includes("[Web search:")) leaks.push(`${file}: no web search query`);
        if (!text.includes("Sources:")) leaks.push(`${file}: no web search sources`);
      }
    }
    expect(leaks).toEqual([]);
    // present_files results render as `[Files: name, ...]` in the survey.
    if (files.length >= 25) expect(sawFiles).toBe(true);
  });
});
