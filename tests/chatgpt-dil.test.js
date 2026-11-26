import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChatGptConversation } from "../src/platforms/chatgpt.js";
import { convertDilMarkup, parseLiteral } from "../src/platforms/chatgpt-dil.js";
import { evidenceFile, evidencePath } from "./helpers/evidence.js";

const fixture = JSON.parse(fs.readFileSync(new URL("./fixtures/chatgpt-dil.json", import.meta.url), "utf8"));
const FORBIDDEN = ["{@body", "{#", "{/", "DIL.", "onChange", "<path", "strokeWidth", "useState", "</box>", "<radio", "<svg"];
// Real captured replies from the private evidence directory; skipped when absent.
const EVIDENCE = evidencePath("chatgpt-dil");
const HAS_EVIDENCE = Boolean(evidenceFile("chatgpt-dil", "a1.txt"));

function convertedFixture() {
  return parseChatGptConversation(fixture).messages[1].text;
}

describe("ChatGPT DIL rich content", () => {
  it("leaves no component source in the copied text", () => {
    const text = convertedFixture();
    for (const token of FORBIDDEN) expect(text).not.toContain(token);
  });

  it("keeps plain Markdown, tables and LaTeX outside components unchanged", () => {
    const text = convertedFixture();
    expect(text.startsWith("Intro with a table:\n\n| Material | n |\n|---|---:|\n| Water | 1.33 |\n\n\\[\nn=\\frac{c}{v}\n\\]")).toBe(true);
    expect(text.endsWith("Closing line.")).toBe(true);
  });

  it("converts layout, math, images and diagrams", () => {
    const text = convertedFixture();
    expect(text).toContain("[Image: straw in water looks bent]");
    expect(text).toContain("\\[\nn=\\frac{c}{v}\n\\]\n\nWhere:\n\n- \\(n\\): index\n- \\(v\\): speed in medium");
    expect(text).toContain("[Diagram: Air · Water · Normal]\n\nThe normal is the dashed line.");
  });

  it("renders static quiz data without answers or feedback", () => {
    const text = convertedFixture();
    expect(text).toContain("1. Speed in water?\n\n- Faster\n- Slower");
    expect(text).not.toContain("Water is denser.");
    expect(text).toContain("**Mini quiz**\n\n1. Which formula?\n- n = c / v\n- n = v / c\nHint: Faster in vacuum.\n\n2. Glass bends light toward the normal.\n- True\n- False");
    expect(text).not.toContain("Right.");
    expect(text).not.toContain("correctValues");
  });

  it("keeps static widget text and marks the interactive part", () => {
    const text = convertedFixture();
    expect(text).toContain("**Calculator** DEG mode\n\nOptions: sin / asin\n\nasin is not 1/sin.\n\n[Interactive widget: not copied]");
    expect(text).toContain("SHIFT sin 0 . 5 =\n\n**30°**");
  });

  it("does not convert messages without the DIL flag", () => {
    expect(parseChatGptConversation(fixture).messages[0].text).toBe("Teach me refraction <box> literally");
    const plain = structuredClone(fixture);
    delete plain.mapping.a1.message.metadata.model_dil_v2;
    expect(parseChatGptConversation(plain).messages[1].text).toContain("<svg viewBox");
  });

  it("does not touch markup inside fenced code blocks", () => {
    const source = "```jsx\n<box>\n  {#if x}y{/if}\n</box>\n```";
    expect(convertDilMarkup(source)).toBe(source);
  });

  it("flags unparseable markup instead of dropping it", () => {
    const text = convertDilMarkup("Before\n\n<box>\n  <text>unclosed\n");
    expect(text).toContain("[Rich content could not be converted]");
    expect(text).toContain("unclosed");
  });

  it("marks unknown components while keeping their text", () => {
    expect(convertDilMarkup("<box>\n  <chart-widget>Sales by month</chart-widget>\n</box>"))
      .toBe("Sales by month\n\n[Unsupported interactive content]\n\n");
  });

  it("parses data literals without executing code", () => {
    expect(parseLiteral("[{q:'a',opts:[\"x\",\"y\"],a:1,},]")).toEqual([{ q: "a", opts: ["x", "y"], a: 1 }]);
    expect(() => parseLiteral("[alert(1)]")).toThrow();
  });

  it.skipIf(!HAS_EVIDENCE)("converts the real captured replies", () => {
    const out = [1, 2, 3, 4, 5].map((n) => convertDilMarkup(fs.readFileSync(`${EVIDENCE}/a${n}.txt`, "utf8"))).join("\n");
    for (const token of [...FORBIDDEN, "[Rich content could not be converted]"]) expect(out).not.toContain(token);
    for (const text of ["折射率越大，光在这种物质中传播得越慢", "法线", "折射率小测验", "26.1039°", "| 水 | 1.33 |", "n=\\frac{c}{v}", "SHIFT sin 0 . 4 4 ="]) {
      expect(out).toContain(text);
    }
  });
});
