import { describe, it, expect, vi } from "vitest";
import { qwenAdapter } from "../src/platforms/qwen.js";
import { copyCurrentConversation } from "../src/core/copy.js";

const url = "https://chat.qwen.ai/c/763f009a-09ef-41e5-a04e-f6123f47a231";
function page({ missingText = false, duplicate = false } = {}) {
  const observers = new Set();
  let stage = 0;
  const changed = () => { for (const cb of observers) cb(); };
  const visible = { getClientRects: () => [{}], closest: () => null };
  const more = { ...visible, click: vi.fn(() => { stage = 1; changed(); }) };
  const download = { ...visible, textContent: "Download", dispatchEvent: vi.fn(() => { stage = 2; changed(); }), click: vi.fn() };
  const text = { ...visible, textContent: "Plain text (.txt)", click: vi.fn() };
  const document = {
    documentElement: {},
    defaultView: { PointerEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } }, MouseEvent: class { constructor(type) { this.type = type; } }, MutationObserver: class { constructor(cb) { this.cb = cb; } observe() { observers.add(this.cb); } disconnect() { observers.delete(this.cb); } } },
    querySelectorAll(selector) {
      if (selector === 'button[aria-label="More"]') return duplicate ? [more, more] : [more];
      if (selector === '[role="menu"] [role="menuitem"]') return stage === 1 ? [download] : stage === 2 && !missingText ? [text] : [];
      throw Error("Unexpected DOM content read");
    }
  };
  return { document, more, download, text, observers };
}

describe("Qwen native TXT export", () => {
  it("keeps global Qwen separate from China and requires a saved chat", () => {
    expect(qwenAdapter.matches(url)).toBe(true);
    for (const other of ["https://qianwen.com/chat/123", "https://chat.qwen.ai/", "http://chat.qwen.ai/c/123", "https://chat.qwen.ai.evil.test/c/123"]) expect(qwenAdapter.matches(other)).toBe(false);
  });
  it("invokes the verified conversation export, not a code-block download", async () => {
    const p = page();
    const fetch = vi.fn(), writeText = vi.fn();
    const result = await copyCurrentConversation({ adapter: qwenAdapter, url, document: p.document, fetch, writeText });
    expect(result).toMatchObject({ ok: true, source: "native", action: "download" });
    expect(result.message).toContain("requested");
    expect(result.messages).toBeUndefined();
    expect(p.more.click).toHaveBeenCalledOnce();
    expect(p.download.click).toHaveBeenCalledOnce();
    expect(p.download.dispatchEvent.mock.calls.map(([event]) => event.type)).toEqual(["pointermove", "mouseover"]);
    expect(p.text.click).toHaveBeenCalledOnce();
    expect(p.observers.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
  it("rejects ambiguous native menus", async () => {
    const p = page({ duplicate: true });
    await expect(qwenAdapter.copyNative({ document: p.document, url })).rejects.toThrow(/ambiguous/);
    expect(p.more.click).not.toHaveBeenCalled();
  });
  it("fails if the TXT option disappeared instead of claiming a download", async () => {
    vi.useFakeTimers();
    try {
      const p = page({ missingText: true });
      const pending = expect(qwenAdapter.copyNative({ document: p.document, url })).rejects.toThrow(/unavailable/);
      await vi.runAllTimersAsync();
      await pending;
      expect(p.text.click).not.toHaveBeenCalled();
      expect(p.observers.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
