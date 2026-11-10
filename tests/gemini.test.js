import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { geminiAdapter, parseGeminiConversation, decodeGeminiHistory } from "../src/platforms/gemini.js";
import { copyCurrentConversation } from "../src/core/copy.js";
const id = "0123456789abcdef", url = `https://gemini.google.com/app/${id}`;
const fixture = () => JSON.parse(readFileSync(new URL("fixtures/gemini.json", import.meta.url), "utf8"));
const framed = data => `)]}'\n123\n${JSON.stringify([["wrb.fr", "hNvQHb", JSON.stringify(data), null]])}\n27\n[["e",4,null,null,1]]\n`;
const document = { scripts: [{ textContent: 'window.WIZ_global_data={"SNlM0e":"ephemeral-test-only"};' }] };
describe("Gemini observed hNvQHb history", () => {
  it("routes only saved Gemini app conversations", () => {
    expect(geminiAdapter.matches(url)).toBe(true);
    for (const x of ["https://gemini.google.com/app", "https://gemini.google.com/share/0123456789abcdef", "http://gemini.google.com/app/0123456789abcdef", "https://evil.test/app/0123456789abcdef"]) expect(geminiAdapter.matches(x)).toBe(false);
  });
  it("decodes a single matching RPC and keeps canonical five-round text", () => {
    const result = parseGeminiConversation(decodeGeminiHistory(framed(fixture())), id);
    expect(result.messages).toHaveLength(10);
    expect(result.messages[0].text).toContain("USER_GEMINI_1_BEGIN");
    expect(result.messages[3].text.match(/可靠复制检查/g)).toHaveLength(30);
    expect(result.messages[9].text).toContain("```python\nprint(42)\n```");
    expect(JSON.stringify(result)).not.toMatch(/REASONING|RENDERING/);
  });
  it("rejects malformed, duplicate, absent and failed history frames", () => {
    for (const raw of ["{}", ")]}'\n[bad", ")]}'\n[[\"wrb.fr\",\"hNvQHb\",null]]", framed(fixture()) + framed(fixture()).slice(5), ")]}'\n[[\"wrb.fr\",\"other\",\"[]\"]]"]) expect(() => decodeGeminiHistory(raw)).toThrow();
  });
  it("refuses pagination, incomplete parents and alternative candidates", () => {
    for (const mutate of [d=>d[3].push("cursor"),d=>d[0].pop(),d=>d[0][0][1][1]="wrong",d=>d[0][0][0][0]="other",d=>d[0][0][0][1]=d[0][1][0][1],d=>d[0][0][3][0].push(d[0][0][3][0][0]),d=>d[0][0][3][9]=false,d=>d[0][0][3][3]="other"]) {
      const data=fixture();mutate(data);expect(()=>parseGeminiConversation(data,id)).toThrow();
    }
  });
  it("refuses attachment, unknown visible fields or missing answer text", () => {
    for (const mutate of [r=>r[2][0][1]=["attachment"],r=>r[2][10].push("attachment"),r=>r[3][0][0][2]=["media"],r=>r[3][0][0][1].push("extra"),r=>r[3][0][0][1][0]=" ",r=>r[3][0][0][28].push("media")]) {const d=fixture();mutate(d[0][0]);expect(()=>parseGeminiConversation(d,id)).toThrow();}
  });
  it("uses ephemeral bootstrap auth without storage or persistent session ids", async () => {
    const fetch=vi.fn(async()=>({ok:true,text:async()=>framed(fixture())}));
    const writeText=vi.fn();
    const result=await copyCurrentConversation({adapter:geminiAdapter,url,fetch,document,writeText,storage:new Proxy({}, {get(){throw Error("storage read");}})});
    expect(result).toMatchObject({ok:true,messages:10,source:"api"});expect(writeText).toHaveBeenCalledOnce();
    const [endpoint,options]=fetch.mock.calls[0];expect(endpoint).not.toMatch(/f.sid|_reqid|token/);expect(options.credentials).toBe("include");
    const form=new URLSearchParams(options.body);expect(form.get("at")).toBe("ephemeral-test-only");
    expect(JSON.parse(form.get("f.req"))[0][0]).toEqual(["hNvQHb",JSON.stringify([`c_${id}`,10,null,1,[0],[4,12],null,1]),null,"generic"]);
  });
  it("reports missing bootstrap and HTTP failures", async()=>{
    await expect(geminiAdapter.extractConversation({url,fetch:vi.fn(),document:{scripts:[]}})).rejects.toMatchObject({code:"not_signed_in"});
    for(const [status,code] of [[401,"not_signed_in"],[403,"permission_denied"],[500,"api_unavailable"]]) await expect(geminiAdapter.extractConversation({url,document,fetch:async()=>({ok:false,status})})).rejects.toMatchObject({code});
  });
});
