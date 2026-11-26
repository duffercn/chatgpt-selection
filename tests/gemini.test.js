import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { geminiAdapter, parseGeminiConversation, decodeGeminiHistory } from "../src/platforms/gemini.js";
import { copyCurrentConversation } from "../src/core/copy.js";
import { formatConversation } from "../src/core/format.js";

const id = "0123456789abcdef", url = `https://gemini.google.com/app/${id}`;
const fixtures = () => JSON.parse(readFileSync(new URL("fixtures/gemini-rich.json", import.meta.url), "utf8")).conversations;
const fixture = () => JSON.parse(readFileSync(new URL("fixtures/gemini.json", import.meta.url), "utf8")).conversations.single;
const multi = () => structuredClone(fixtures().multi);
const framed = data => `)]}'\n123\n${JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify(data), null]])}\n27\n[["e",4,null,null,1]]\n`;
const document = { scripts: [{ textContent: 'window.WIZ_global_data={"SNlM0e":"ephemeral-test-only"};' }] };

describe("Gemini observed hNvQHb history", () => {
  it("routes only saved Gemini app conversations", () => {
    expect(geminiAdapter.matches(url)).toBe(true);
    for (const x of ["https://gemini.google.com/app", "https://gemini.google.com/share/0123456789abcdef", "http://gemini.google.com/app/0123456789abcdef", "https://evil.test/app/0123456789abcdef"]) expect(geminiAdapter.matches(x)).toBe(false);
  });

  it("decodes a single matching RPC", () => {
    expect(parseGeminiConversation(decodeGeminiHistory(framed(fixture())), id).messages).toHaveLength(2);
  });

  it("rejects malformed, duplicate, absent and failed history frames", () => {
    for (const raw of ["{}", ")]}'\n[bad", ")]'\n[[\"wrb.fr\",\"hNvQHb\",null]]", framed(fixture()) + framed(fixture()).slice(5), ")]}'\n[[\"wrb.fr\",\"other\",\"[]\"]]"]) expect(() => decodeGeminiHistory(raw)).toThrow();
  });

  it("reads the current 16-field record layout", () => {
    const data = fixture(), record = data[0][0];
    expect(record).toHaveLength(16);
    expect(record[0]).toEqual([`c_${id}`, "r_0000000000000001"]);
    expect(record[1]).toBeNull();
    expect(record[2]).toHaveLength(11);
    expect(record[3]).toHaveLength(32);
    expect(record[3][0][0].length).toBeGreaterThanOrEqual(29);
    const parsed = parseGeminiConversation(data, id);
    expect(parsed.messages.map(m => [m.role, m.text])).toEqual([["user", "USER_GEMINI_ONE"], ["assistant", "ASSISTANT_GEMINI_ONE"]]);
    expect(formatConversation(parsed)).toBe("User:\nUSER_GEMINI_ONE\n\n────────────────────\n\nGemini:\nASSISTANT_GEMINI_ONE");
  });

  it("accepts 5/7/9/11-field user messages", () => {
    for (const length of [5, 7, 9]) {
      const data = fixture(), user = data[0][0][2];
      user.length = length;
      expect(parseGeminiConversation(data, id).messages[0].text).toBe("USER_GEMINI_ONE");
    }
  });

  it("refuses pagination, a broken parent chain and an ambiguous branch", () => {
    const mutations = [
      d => { d[1] = ["token"]; },
      d => { d[2] = ["token"]; },
      d => { d[3] = [["unexpected"]]; },
      d => { d[0].push(structuredClone(d[0][0])); },
      d => { d[0].length = 0; },
      d => { d[0][0][1][1] = "r_other"; },
      d => { d[0][0][1][0] = "c_other"; },
      d => { d[0][0][1][2] = "rc_other"; },
      d => { d[0][0][0][0] = "c_other"; },
      d => { d[0][0][3][0] = []; },
      d => { d[0][0][3][3] = "rc_other"; },
      d => { d[0][0][3][0][0][0] = "rc_other"; },
      // a second, competing child of the same turn
      d => { d[0].push(structuredClone(d[0][1])); d[0][d[0].length - 1][0][1] = "r_fork"; d[0][d[0].length - 1][1][1] = "r_0000000000000002"; },
      // a truncated history: the oldest turn still names a parent
      d => { d[0].pop(); }
    ];
    expect(() => { const d = multi(); d[1] = ["token"]; return parseGeminiConversation(d, id); }).toThrow(/paginated/);
    for (const mutate of mutations) {
      const data = multi();
      mutate(data);
      expect(() => parseGeminiConversation(data, id), mutate.toString()).toThrow(/Gemini:/);
    }
  });

  it("keeps the previous alternative out of the copy", () => {
    const data = fixture();
    data[0][0][3][0].push(structuredClone(data[0][0][3][0][0]));
    data[0][0][3][0][1][0] = "rc_0000000000000002";
    data[0][0][3][0][1][1] = ["ASSISTANT_GEMINI_OLD"];
    const parsed = parseGeminiConversation(data, id);
    expect(JSON.stringify(parsed)).not.toContain("ASSISTANT_GEMINI_OLD");
  });

  it("uses ephemeral bootstrap auth without storage or persistent session ids", async () => {
    const fetch = vi.fn(async () => ({ ok: true, text: async () => framed(fixture()) }));
    const writeText = vi.fn();
    const result = await copyCurrentConversation({ adapter: geminiAdapter, url, fetch, document, writeText, storage: new Proxy({}, { get() { throw Error("storage read"); } }) });
    expect(result).toMatchObject({ ok: true, messages: 2, source: "api" });
    expect(writeText).toHaveBeenCalledOnce();
    const [endpoint, options] = fetch.mock.calls[0];
    expect(endpoint).not.toMatch(/f.sid|_reqid|token/);
    expect(options.credentials).toBe("include");
    expect(new URLSearchParams(options.body).get("at")).toBe("ephemeral-test-only");
    expect(JSON.parse(new URLSearchParams(options.body).get("f.req"))[0][0]).toEqual(["hNvQHb", JSON.stringify([`c_${id}`, 10, null, 1, [0], [4, 12], null, 1]), null, "generic"]);
  });

  it("reports missing bootstrap and HTTP failures", async () => {
    await expect(geminiAdapter.extractConversation({ url, fetch: vi.fn(), document: { scripts: [] } })).rejects.toMatchObject({ code: "not_signed_in" });
    for (const [status, code] of [[401, "not_signed_in"], [403, "permission_denied"], [500, "api_unavailable"]]) await expect(geminiAdapter.extractConversation({ url, document, fetch: async () => ({ ok: false, status }) })).rejects.toMatchObject({ code });
  });
});
