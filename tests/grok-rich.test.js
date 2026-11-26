import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatConversation } from "../src/core/format.js";
import { hostName } from "../src/core/rich.js";
import { parseGrokConversation } from "../src/platforms/grok.js";
import { evidenceFiles, surveyDir } from "./helpers/evidence.js";
import {
  citedCardIds,
  grokReferences,
  parseCards,
  renderGrokMessage,
  renderGrokText,
  searchReferences,
  xPostReferences,
  xPostTitle
} from "../src/platforms/grok-rich.js";

// Synthetic tags/cards. Real Grok responses are private and never checked in.
const CITATION_TAG = (id, citationId = "1") =>
  `<grok:render card_id="${id}" card_type="citation_card" type="render_inline_citation"><argument name="citation_id">${citationId}</argument></grok:render>`;
const IMAGE_TAG = (id) =>
  `<grok:render card_id="${id}" card_type="image_card" type="render_searched_image"><argument name="image_id">img${id}</argument></grok:render>`;
const card = (value) => JSON.stringify(value);
const citationCard = (id, url) => card({ id, type: "render_inline_citation", cardType: "citation_card", url, kind: 1 });

const conversation = (answer) => ({
  title: "Rich",
  currentResponseId: "a1",
  responses: [
    { responseId: "u1", parentResponseId: "conversation-root", sender: "user", message: "Question" },
    { responseId: "a1", parentResponseId: "u1", sender: "assistant", ...answer }
  ]
});

const answerOf = (data) => parseGrokConversation(data).messages[1];
const LEAKS = ["<grok:", "</grok:", "<argument", "card_id"];

describe("Grok inline cards", () => {
  it("replaces a citation tag with a domain link from the matching card", () => {
    const data = conversation({
      message: `Answer${CITATION_TAG("c1")} and more${CITATION_TAG("c2", "2")}.`,
      cardAttachmentsJson: [
        citationCard("c1", "https://www.example.com/a"),
        citationCard("c2", "http://docs.example.org/b?q=1")
      ]
    });
    expect(answerOf(data).text).toBe("Answer ([example.com](https://www.example.com/a)) and more ([docs.example.org](http://docs.example.org/b?q=1)).");
  });

  it("removes the tag when the card is missing, misidentified or not an http(s) url", () => {
    const data = conversation({
      message: `A${CITATION_TAG("missing")}B${CITATION_TAG("rel")}C${CITATION_TAG("nourl")}D`,
      cardAttachmentsJson: [
        citationCard("rel", "/relative/path"),
        card({ id: "nourl", type: "render_inline_citation", cardType: "citation_card", kind: 1 })
      ]
    });
    expect(answerOf(data).text).toBe("ABCD");
  });

  it("links an X-post citation and renders image cards as static text", () => {
    const data = conversation({
      message: `See${CITATION_TAG("x1")} this${IMAGE_TAG("i1")}`,
      cardAttachmentsJson: [
        citationCard("x1", "https://x.com/example_user/status/2123456789012345678"),
        card({
          id: "i1",
          type: "render_searched_image",
          cardType: "image_card",
          image: { thumbnail: "https://img.example.net/t.jpg", source: "Example", title: "Search result image", link: "https://www.example.net/article" },
          size: "LARGE"
        })
      ]
    });
    expect(answerOf(data).text).toBe(
      "See ([@example_user](https://x.com/example_user/status/2123456789012345678)) this[Image: Search result image](https://www.example.net/article)"
    );
  });

  it("renders a placeholder for unknown card types and never leaks tags", () => {
    const text = renderGrokText(
      `A<grok:render card_id="u1" card_type="mystery_card" type="render_mystery"><argument name="x">1</argument></grok:render>B<grok:render card_id="bad">C`,
      []
    );
    // The known tag keeps a visible marker; the unclosed second tag is a
    // truncated reply, so its markup and tail are dropped.
    expect(text).toBe("A[Grok content: mystery_card]B");
    expect(renderGrokText(`A<grok:render card_id="u1" card_type="mystery_card" type="render_mystery"></grok:render>B`, []))
      .toBe("A[Grok content: mystery_card]B");
    expect(parseCards(["not json", null, 5, citationCard("ok", "https://ok.example")])).toHaveLength(1);
  });

  it("names the card's own type in the placeholder when the tag is silent", () => {
    // A known card id whose type the renderer cannot handle still keeps content.
    const cards = parseCards([card({ id: "k1", type: "render_weather", cardType: "weather_card" })]);
    expect(renderGrokText(`Today<grok:render card_id="k1"></grok:render>`, cards)).toBe("Today[Grok content: weather_card]");
    // A tag with no matching card and no type falls back to a generic marker.
    expect(renderGrokText(`X<grok:render card_id="gone" card_type=""></grok:render>Y`, cards)).toBe("X[Grok content: unknown]Y");
  });

  it("still drops citation tags that have no visible content to keep", () => {
    const text = renderGrokText(
      `A${CITATION_TAG("missing")}B${CITATION_TAG("rel")}C`,
      parseCards([citationCard("rel", "/relative/path")])
    );
    expect(text).toBe("ABC");
    expect(text).not.toContain("[Grok content:");
  });

  it("drops tag markup from a truncated or unexpected tag form", () => {
    // A reply cut off inside a card tag keeps its prose and loses the markup.
    expect(renderGrokText(`Cut off here<grok:render card_id="c1" card_type="citation_card`, []))
      .toBe("Cut off here");
    expect(renderGrokText("Kept<xai:thing> text</argument>", [])).toBe("Kept text");
    expect(renderGrokText("Plain answer", [])).toBe("Plain answer");
    expect(renderGrokText("", [])).toBe("");
  });

  it("reads single-quoted attributes and tolerates a card tag with no arguments", () => {
    const text = renderGrokText(
      "A<grok:render card_id='c1' card_type='citation_card' type='render_inline_citation'><argument name='citation_id'>1</argument></grok:render>B",
      parseCards([citationCard("c1", "https://sub.example.com/p")])
    );
    expect(text).toBe("A ([sub.example.com](https://sub.example.com/p))B");
    expect(renderGrokText("X<grok:render card_id='c1' card_type='citation_card'></grok:render>Y", parseCards([citationCard("c1", "https://s.example.com")])))
      .toBe("X ([s.example.com](https://s.example.com))Y");
    expect(hostName("not a url")).toBe("");
  });
});

describe("Grok references", () => {
  it("keeps a search-result title per URL, ignoring unusable entries", () => {
    const titles = searchReferences([
      { url: "https://one.example/a", title: "  First   source " },
      { url: "https://one.example/a", title: "Duplicate" },
      { url: "javascript:alert(1)", title: "Rejected" },
      { url: "https://two.example", title: "" },
      { url: "https://two.example", title: "Later title" },
      { url: "https://three.example", title: "Third" },
      { url: undefined, title: "No URL" }
    ]);
    expect([...titles]).toEqual([
      ["https://one.example/a", "First source"],
      ["https://two.example", "Later title"],
      ["https://three.example", "Third"]
    ]);
    expect(searchReferences(undefined).size).toBe(0);
  });

  it("maps xposts to post titles keyed by their canonical url", () => {
    const longText = `Line one\n\n${"x".repeat(120)}`;
    const titles = xPostReferences([
      { username: "example_user", name: "Example", text: longText, postId: "111", citationId: "" },
      { username: "other_user", text: "Short post", postId: "222" },
      { username: "bad user", text: "Rejected", postId: "333" },
      { username: "no_post", text: "Rejected" }
    ]);
    expect([...titles]).toEqual([
      ["https://x.com/example_user/status/111", `@example_user: Line one ${"x".repeat(71)}…`],
      ["https://x.com/other_user/status/222", "@other_user: Short post"]
    ]);
    expect(xPostTitle({})).toBe("X post");
    expect(xPostTitle({ username: "solo" })).toBe("@solo");
    expect(xPostReferences(null).size).toBe(0);
  });

  it("lists only the cited cards, in citation order and deduplicated by URL", () => {
    const node = {
      message: `A${CITATION_TAG("c2")}B${CITATION_TAG("c1", "2")}C${CITATION_TAG("c2", "3")}`,
      cardAttachmentsJson: [
        citationCard("c1", "https://one.example/a"),
        citationCard("c2", "https://two.example/b")
      ],
      webSearchResults: [
        { url: "https://one.example/a", title: "One" },
        { url: "https://two.example/b", title: "Two" },
        { url: "https://uncited.example/c", title: "Uncited" }
      ]
    };
    expect(grokReferences(node)).toEqual([
      { title: "Two", url: "https://two.example/b" },
      { title: "One", url: "https://one.example/a" }
    ]);
    // Two cards pointing at the same URL count once, keeping the first citation.
    const shared = { ...node, cardAttachmentsJson: [citationCard("c1", "https://one.example/a"), citationCard("c2", "https://one.example/a")] };
    expect(grokReferences(shared)).toEqual([{ title: "One", url: "https://one.example/a" }]);
  });

  it("titles an X-post citation from the matching xpost and falls back to the domain", () => {
    const node = {
      message: `See${CITATION_TAG("x1")} and${CITATION_TAG("c1")} and${CITATION_TAG("c2")} and${CITATION_TAG("c3")}`,
      cardAttachmentsJson: [
        citationCard("x1", "https://x.com/example_user/status/111"),
        citationCard("c1", "https://docs.example.org/guide?q=1"),
        citationCard("c2", "https://x.com/stranger/status/999"),
        citationCard("c3", "https://www.www-free.example/p")
      ],
      xposts: [{ username: "example_user", text: "Post text", postId: "111" }]
    };
    expect(grokReferences(node)).toEqual([
      { title: "@example_user: Post text", url: "https://x.com/example_user/status/111" },
      { title: "docs.example.org", url: "https://docs.example.org/guide?q=1" },
      { title: "x.com", url: "https://x.com/stranger/status/999" },
      { title: "www-free.example", url: "https://www.www-free.example/p" }
    ]);
  });

  it("prefers a search-result title over the X-post title and over the domain", () => {
    const node = {
      message: `A${CITATION_TAG("x1")}B${CITATION_TAG("c1")}`,
      cardAttachmentsJson: [
        citationCard("x1", "https://x.com/example_user/status/111"),
        citationCard("c1", "https://one.example/a")
      ],
      webSearchResults: [{ url: "https://x.com/example_user/status/111", title: "Search title" }],
      xposts: [{ username: "example_user", text: "Post text", postId: "111" }]
    };
    expect(grokReferences(node)).toEqual([
      { title: "Search title", url: "https://x.com/example_user/status/111" },
      { title: "one.example", url: "https://one.example/a" }
    ]);
  });

  it("lists nothing for a reply with search results but no citation tags", () => {
    const node = {
      message: "Answer with no inline cards",
      webSearchResults: [{ url: "https://one.example/a", title: "Uncited" }],
      xposts: [{ username: "example_user", text: "Uncited post", postId: "111" }]
    };
    expect(grokReferences(node)).toEqual([]);
    expect(grokReferences({})).toEqual([]);
    expect(grokReferences(null)).toEqual([]);
  });

  it("ignores citations whose card is missing, uncited or not an http(s) url", () => {
    const node = {
      message: `A${CITATION_TAG("missing")}B${CITATION_TAG("rel")}C${CITATION_TAG("nourl")}D${IMAGE_TAG("i1")}`,
      cardAttachmentsJson: [
        citationCard("rel", "/relative/path"),
        card({ id: "nourl", type: "render_inline_citation", cardType: "citation_card", kind: 1 }),
        card({ id: "i1", type: "render_searched_image", cardType: "image_card", image: { title: "Image" } })
      ]
    };
    expect(grokReferences(node)).toEqual([]);
  });

  it("counts only citations that the inline rendering actually shows", () => {
    // A tag opened before its neighbour closed carries nothing; a truncated reply
    // loses the unfinished tag. Neither may appear as a reference.
    const broken = `<grok:render card_id="c1" card_type="citation_card" type="render_inline_citation" ${CITATION_TAG("c2")}`;
    expect(grokReferences({ message: broken, cardAttachmentsJson: [citationCard("c1", "https://one.example/a"), citationCard("c2", "https://two.example/b")] }))
      .toEqual([{ title: "two.example", url: "https://two.example/b" }]);
    const truncated = `Answer${CITATION_TAG("c1")}<grok:render card_id="c2" card_type="citation_card" type="render_inline_citation"`;
    expect(grokReferences({ message: truncated, cardAttachmentsJson: [citationCard("c1", "https://one.example/a"), citationCard("c2", "https://two.example/b")] }))
      .toEqual([{ title: "one.example", url: "https://one.example/a" }]);
  });

  it("attaches cited references to the reply and formats them as sources", () => {
    const data = conversation({
      message: `Answer${CITATION_TAG("c1")} and${CITATION_TAG("x1")}`,
      cardAttachmentsJson: [
        citationCard("c1", "https://www.example.com/a"),
        citationCard("x1", "https://x.com/example_user/status/111")
      ],
      webSearchResults: [
        { url: "https://www.example.com/a", title: "Example source", preview: "…" },
        { url: "https://uncited.example/b", title: "Uncited source" }
      ],
      xposts: [{ username: "example_user", name: "Example", text: "Post text", postId: "111", citationId: "" }]
    });
    const parsed = parseGrokConversation(data, "groked");
    expect(parsed.messages[0]).toEqual({ role: "user", text: "Question" });
    expect(parsed.messages[1]).toEqual({
      role: "assistant",
      text: "Answer ([example.com](https://www.example.com/a)) and ([@example_user](https://x.com/example_user/status/111))",
      references: [
        { title: "Example source", url: "https://www.example.com/a" },
        { title: "@example_user: Post text", url: "https://x.com/example_user/status/111" }
      ]
    });
    const output = formatConversation(parsed);
    expect(output).toContain("[Source: Example source](https://www.example.com/a)");
    expect(output).toContain("[Source: @example_user: Post text](https://x.com/example_user/status/111)");
    expect(output).not.toContain("Uncited source");
  });

  it("lists no references for a reply that has search results but cites nothing", () => {
    const data = conversation({
      message: "Answer",
      webSearchResults: [{ url: "https://www.example.com/a", title: "Example source" }],
      xposts: [{ username: "example_user", text: "Post text", postId: "111" }]
    });
    expect(answerOf(data)).toEqual({ role: "assistant", text: "Answer" });
    expect(formatConversation(parseGrokConversation(data))).not.toContain("[Source:");
  });

  it("keeps sources of a reply with empty prose next to an earlier reply and yields no leak", () => {
    const data = conversation({
      message: "",
      partial: true,
      webSearchResults: [{ url: "https://one.example/a", title: "Orphan" }]
    });
    expect(parseGrokConversation(data).messages).toEqual([{ role: "user", text: "Question" }]);
  });

  it("skips an empty reply but keeps the citations of a reply with prose", () => {
    const data = {
      currentResponseId: "a2",
      responses: [
        { responseId: "u1", parentResponseId: "conversation-root", sender: "user", message: "Question" },
        { responseId: "a1", parentResponseId: "u1", sender: "assistant", message: "", partial: true, webSearchResults: [{ url: "https://one.example/a", title: "Orphan" }, { url: "https://two.example/b", title: "Also orphan" }] },
        { responseId: "u2", parentResponseId: "a1", sender: "user", message: "Follow-up" },
        {
          responseId: "a2",
          parentResponseId: "u2",
          sender: "assistant",
          message: `Answer${CITATION_TAG("c2")}`,
          cardAttachmentsJson: [citationCard("c1", "https://one.example/a"), citationCard("c2", "https://two.example/b")],
          webSearchResults: [{ url: "https://one.example/a", title: "Uncited" }, { url: "https://two.example/b", title: "Kept" }]
        }
      ]
    };
    // The empty reply adds no message and no orphan sources; the user turns stay
    // adjacent and the real reply keeps only the source it cites.
    expect(parseGrokConversation(data).messages).toEqual([
      { role: "user", text: "Question" },
      { role: "user", text: "Follow-up" },
      { role: "assistant", text: "Answer ([two.example](https://two.example/b))", references: [{ title: "Kept", url: "https://two.example/b" }] }
    ]);
  });

  it("renders every message without leaking tags", () => {
    const data = conversation({ message: `Answer${CITATION_TAG("c1")}`, cardAttachmentsJson: [citationCard("c1", "https://www.example.com")] });
    const output = formatConversation(parseGrokConversation(data));
    for (const leak of LEAKS) expect(output).not.toContain(leak);
    expect(output).toContain("[Source: example.com](https://www.example.com)");
    expect(renderGrokMessage({ message: "x" }).text).toBe("x");
  });
});

// Replays every real conversation from the private evidence directory through
// the adapter. Nothing is written; only assertions run.
const surveyFiles = evidenceFiles(surveyDir("grok"));
describe.skipIf(!surveyFiles.length)("Grok survey evidence", () => {
  it("formats every surveyed conversation without leaking tags", () => {
    const files = surveyFiles;
    expect(files.length).toBeGreaterThan(0);
    const outputs = new Map(files.map(({ index, file, path }) => {
      const data = JSON.parse(readFileSync(path, "utf8"));
      const conversation = parseGrokConversation(data, String(index));
      expect(conversation.messages.length).toBeGreaterThan(0);
      const output = formatConversation(conversation);
      for (const leak of LEAKS) expect(output, `${file} leaks ${leak}`).not.toContain(leak);
      return [index, output];
    }));
    expect(outputs.get(3)).toContain("[Source:");
  });

  it("only renders a placeholder for a card type the renderer does not know", () => {
    // Every recorded card is a citation or a searched image, so no reply needs
    // an unknown-content marker; a marker in real data would mean a new type.
    const known = new Set(["citation_card", "image_card"]);
    const markers = [];
    for (const { index, path } of surveyFiles) {
      const data = JSON.parse(readFileSync(path, "utf8"));
      const output = formatConversation(parseGrokConversation(data, String(index)));
      for (const match of output.matchAll(/\[Grok content: ([^\]]+)\]/g)) {
        markers.push(`${index}: ${match[1]}`);
        expect(known.has(match[1]), `conversation ${index} has an unknown card type`).toBe(true);
      }
    }
    expect(markers).toEqual([]);
  });
});
