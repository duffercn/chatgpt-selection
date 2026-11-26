import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { formatConversation } from "../src/core/format.js";
import { convertDilMarkup } from "../src/platforms/chatgpt-dil.js";
import { replaceCitationMarkers } from "../src/platforms/chatgpt-refs.js";
import { parseChatGptConversation } from "../src/platforms/chatgpt.js";
import { evidenceFiles, surveyDir } from "./helpers/evidence.js";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/chatgpt-refs.json", import.meta.url), "utf8"));
// Real API responses from the private evidence directory; never committed.
const SURVEY = surveyDir("chatgpt");

// Markers are built from private-use characters; write them with escapes so the
// source stays readable.
const PUA_OPEN = "\uE200";
const PUA_ARG = "\uE202";
const PUA_CLOSE = "\uE201";
const PRIVATE_USE = /[\uE000-\uF8FF]/;
const marker = (name, ...args) => [PUA_OPEN, name, ...args.flatMap((arg) => [PUA_ARG, arg]), PUA_CLOSE].join("");

function ref(type, matched, extra = {}) {
  return { type, matched_text: matched, alt: "", start_idx: 0, end_idx: 0, ...extra };
}

function parse(text, references) {
  const data = {
    conversation_id: "synthetic",
    current_node: "a",
    mapping: {
      root: { id: "root", parent: null, message: null },
      u: { id: "u", parent: "root", message: { author: { role: "user" }, content: { parts: ["Hi"] } } },
      a: { id: "a", parent: "u", message: { author: { role: "assistant" }, metadata: { content_references: references }, content: { parts: [text] } } }
    }
  };
  return parseChatGptConversation(data).messages.at(-1).text;
}

describe("ChatGPT citation markers", () => {
  const cite = marker("cite", "turn0search0", "turn0search3");
  const url = marker("url", "Official notes", "turn0search2");

  it("replaces search citations with the readable link and drops tracking parameters", () => {
    const text = parse(`Red apples${cite}, pears${url}.`, [
      ref("grouped_webpages", cite, { alt: "([Orchard](https://e.org/n?utm_source=chatgpt.com))" }),
      ref("url", url, { alt: "[Official notes](https://e.org/a?utm_source=chatgpt.com)" })
    ]);
    expect(text).toBe("Red apples([Orchard](https://e.org/n)), pears[Official notes](https://e.org/a).");
  });

  it("lists image queries instead of private image URLs", () => {
    const images = marker("image_group", JSON.stringify({ layout: "carousel", query: ["red apple", "pear tree"] }));
    const text = parse(`See${images}`, [ref("image_group", images, { alt: "![Image](https://images.openai.com/static/x)" })]);
    expect(text).toBe("See[Images: red apple · pear tree]");
    expect(text).not.toContain("images.openai.com");
  });

  it("removes hidden markers and keeps footnote spacing", () => {
    const hidden = marker("hidden", "");
    const footnote = " ";
    const text = parse(`A${hidden}B's source${footnote}C`, [ref("hidden", ""), ref("sources_footnote", footnote)]);
    expect(text).toBe("AB's source C");
  });

  it("reveals writing blocks from their reference data", () => {
    const body = "# Plan\n\nStep one.\n\nStep two.";
    const matched = `:::writing{variant="document" id="1"}\n${body}\n:::`;
    const text = parse(`Here you go.\n\n${matched}`, [
      ref("client_defined_widget", matched, { category: "writing_block", data: { content: body, widget_type: "writing_block" } })
    ]);
    expect(text).toBe(`Here you go.\n\n${body}`);
  });

  it("leaves code blocks verbatim when their reference arrives before the text", () => {
    const code = "```bash\nnpm test\n```";
    const text = parse(code, [ref("client_defined_widget", code, { category: "code_block", data: { content: "npm test", language: "bash", widget_type: "code_block" } })]);
    expect(text).toBe(code);
  });

  it("never leaves private-use characters behind, even for unreferenced markers", () => {
    const unknown = marker("cite", "turn0search7");
    const text = parse(`Answer${unknown} here`, []);
    expect(text).toBe("Answer here");
    expect(PRIVATE_USE.test(text)).toBe(false);
    expect(text).not.toContain("turn0search");
  });

  it("strips markers without executing anything", () => {
    expect(replaceCitationMarkers("a", [])).toBe("a");
    expect(replaceCitationMarkers("a", undefined)).toBe("a");
    expect(PRIVATE_USE.test(replaceCitationMarkers(marker("cite", "x"), null))).toBe(false);
  });

  it("applies citation replacement to the parsed conversation", () => {
    const messages = parseChatGptConversation(fixture).messages;
    const assistant = messages[1].text;
    expect(assistant).toContain("([Orchard notes](https://example.org/notes))");
    expect(assistant).not.toContain("utm_source=chatgpt.com");
    expect(assistant).toContain("[Images: red apple orchard · green pear tree]");
    for (const message of messages) expect(PRIVATE_USE.test(message.text)).toBe(false);
  });
});

describe("ChatGPT DIL components added from the survey", () => {
  it("renders layout, lists and tables as Markdown", () => {
    const source = [
      "<grid columns={2}>",
      "  <grid-item>",
      "    <col gap={1}>",
      "      **Orchard**",
      "      <list marker=\"number\">",
      "        <list-item>Pick in autumn</list-item>",
      "        <list-item>Store cool</list-item>",
      "      </list>",
      "    </col>",
      "  </grid-item>",
      "</grid>"
    ].join("\n");
    expect(convertDilMarkup(source)).toBe("**Orchard**\n\n1. Pick in autumn\n\n2. Store cool\n\n");
  });

  it("renders static tables, including wrapped rows", () => {
    const source = [
      "<table>",
      "  <table-row><table-cell>**Fruit**</table-cell><table-cell>Season</table-cell></table-row>",
      "  <table-row>",
      "    <table-cell>Apple</table-cell><table-cell>Autumn</table-cell>",
      "  </table-row>",
      "</table>"
    ].join("\n");
    expect(convertDilMarkup(source)).toBe("| **Fruit** | Season |\n|---|---|\n| Apple | Autumn |\n\n");
  });

  it("renders links, entities, code blocks and charts", () => {
    const source = [
      "See <Link url=\"https://e.org/guide\" title=\"Guide\"/> and <Entity value=\"Malus domestica\"/>.",
      "",
      "<CodeBlock language=\"python\">",
      "print(\"apple\")",
      "</CodeBlock>",
      "",
      "<Chart content={{chartType:'bar',meta:{title:'Harvest',description:'Sample data only.'},xKey:'year',series:[{dataKey:'tons',label:'Tons'}],data:[{year:2024,tons:12},{year:2025,tons:15}]}}/>"
    ].join("\n");
    const text = convertDilMarkup(source);
    expect(text).toContain("See [Guide](https://e.org/guide) and Malus domestica.");
    expect(text).toContain("```python\nprint(\"apple\")\n```");
    expect(text).toContain("[Chart: Harvest]\n\n| year | Tons |\n|---|---|\n| 2024 | 12 |\n| 2025 | 15 |\n\nSample data only.");
  });

  it("renders image groups and interactive controls", () => {
    const source = [
      "<AsyncImageGroup query={[\"apple close-up\",\"pear close-up\"]}/>",
      "",
      "<slider min={1} max={10} marks={[{value:1,label:'1'},{value:10,label:'10'}]}/>",
      "",
      "<pressable>",
      "  **Details**",
      "</pressable>"
    ].join("\n");
    const text = convertDilMarkup(source);
    expect(text).toContain("[Image: apple close-up]\n\n[Image: pear close-up]");
    expect(text).toContain("Options: 1 / 10");
    expect(text).toContain("[Interactive widget: not copied]");
    expect(text).toContain("**Details**");
  });

  it("keeps one widget note per widget and drops its click handlers", () => {
    const source = [
      "<box>",
      "  <row>",
      "    **Calculator**",
      "    <badge>DEG</badge>",
      "  </row>",
      "  <segmented-control options={[{\"label\":\"sin\"},{\"label\":\"asin\"}]} onChange={v=>setMode(v)}/>",
      "  <input value={angle} onChange={setAngle}/>",
      "</box>",
      "",
      "<box>",
      "  <title>30°</title>",
      "</box>"
    ].join("\n");
    const text = convertDilMarkup(source);
    expect(text).toContain("**Calculator** DEG\n\nOptions: sin / asin\n\n[Interactive widget: not copied]");
    expect(text.match(/\[Interactive widget: not copied\]/g)).toHaveLength(1);
    expect(text).not.toContain("onChange");
    expect(text).not.toContain("[Unsupported interactive content]");
  });

  it("drops citations that have no URL to show", () => {
    expect(convertDilMarkup("Claim.<Cite refs={[\"turn0search0\"]}/>")).toBe("Claim.");
    expect(convertDilMarkup("Claim.<FileCite ref=\"turn0file0\"/>")).toBe("Claim.");
    expect(convertDilMarkup("Data.<Cite refs={[\"https://e.org/source\"]}/>")).toContain("https://e.org/source");
  });

  it("renders a list template once when its items live in runtime state", () => {
    const source = "<box>\n  {#each ranked as p}\n    <text>{p.n}</text>\n  {/each}\n</box>";
    expect(convertDilMarkup(source)).toBe("");
  });

  it("still flags components it cannot render", () => {
    expect(convertDilMarkup("<box>\n  <chart-widget>Sales</chart-widget>\n</box>")).toBe("Sales\n\n[Unsupported interactive content]\n\n");
  });
});

describe("ChatGPT user messages", () => {
  it("keeps user text byte-for-byte, even when it contains component markup", () => {
    const messages = parseChatGptConversation(fixture).messages;
    expect(messages[2].text).toBe("A pasted transcript:\n\n<box border radius=\"md\">\n  **People — decide**\n</box>\n\nand a<b stays as typed");
  });
});

describe("ChatGPT survey evidence", () => {
  const files = evidenceFiles(SURVEY);

  it.skipIf(!files.length)("copies every captured conversation without leaked markup or markers", () => {
    const forbidden = ["{@body", "{#", "</box>", "<box", "<svg", "<path", "onChange", "useState", "[Rich content could not be converted]", "turn0search"];
    const unsupported = [];
    for (const { file: name, path } of files) {
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      const conversation = parseChatGptConversation(data);
      const output = formatConversation({ ...conversation, messages: conversation.messages.filter((m) => m.role === "assistant") });
      expect(PRIVATE_USE.test(output), `${name} kept private-use characters`).toBe(false);
      for (const token of forbidden) expect(output, `${name} leaked ${token}`).not.toContain(token);
      const count = (output.match(/\[Unsupported interactive content\]/g) || []).length;
      if (count) unsupported.push(`${name}:${count}`);
    }
    expect(unsupported, "components still needing conversion").toEqual([]);
  });
});
