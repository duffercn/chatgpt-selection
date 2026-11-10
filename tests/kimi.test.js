import { describe, it, expect, vi } from "vitest";
import { kimiAdapter } from "../src/platforms/kimi.js";
import { copyCurrentConversation } from "../src/core/copy.js";

function nativePage({ selected = true, confirm = true, duplicate = false } = {}) {
  const observers = new Set();
  const visible = { getClientRects: () => [{}], closest: () => null };
  const checkbox = { ...visible, checked: selected, isConnected: true };
  let panel = false;
  let copied = false;
  const notify = () => { for (const check of observers) check(); };
  const share = { ...visible, click: vi.fn(() => { panel = true; notify(); }) };
  const select = { ...visible, click: vi.fn(() => { checkbox.checked = true; notify(); }) };
  const copy = { ...visible, textContent: "Copy text", click: vi.fn(() => { copied = confirm; notify(); }) };
  const document = {
    documentElement: {},
    defaultView: { MutationObserver: class { constructor(check) { this.check = check; } observe() { observers.add(this.check); } disconnect() { observers.delete(this.check); } } },
    querySelector(selector) { if (selector === ".share-bottom-container") return panel ? {} : null; throw Error(`Unexpected content read: ${selector}`); },
    querySelectorAll(selector) {
      if (selector.includes('svg[name="Share_a"]')) return [share];
      if (selector.includes('input[type="checkbox"]')) return panel ? [checkbox] : [];
      if (selector === ".share-bottom-container .select-all") return panel ? [select] : [];
      if (selector === ".share-bottom-container .main-button") return panel ? duplicate ? [copy, copy] : [copy] : [];
      if (selector.includes(".message-list-container")) return copied ? [{ ...visible, textContent: "Text copied successfully" }] : [];
      throw Error(`Unexpected content read: ${selector}`);
    }
  };
  return { document, share, select, copy, observers };
}

const url = "https://kimi.com/chat/1a020763-6cd2-8165-8000-098e25b257f8";
describe("Kimi native complete-conversation copy", () => {
  it("routes only saved HTTPS Kimi chats", () => {
    expect(kimiAdapter.matches(url)).toBe(true);
    for (const value of ["https://kimi.com/", "https://kimi.com/chat/123/other", "http://kimi.com/chat/123", "https://evil.example/chat/123"]) expect(kimiAdapter.matches(value)).toBe(false);
  });
  it("opens native Share and preserves an already selected complete conversation", async () => {
    const page = nativePage();
    const result = await kimiAdapter.copyNative({ document: page.document, url });
    expect(page.share.click).toHaveBeenCalledOnce();
    expect(page.select.click).not.toHaveBeenCalled();
    expect(page.copy.click).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, source: "native", action: "copy" });
    expect(page.observers.size).toBe(0);
  });
  it("selects all before copying a partially selected conversation", async () => {
    const page = nativePage({ selected: false });
    await kimiAdapter.copyNative({ document: page.document, url });
    expect(page.select.click).toHaveBeenCalledOnce();
    expect(page.select.click.mock.invocationCallOrder[0]).toBeLessThan(page.copy.click.mock.invocationCallOrder[0]);
  });
  it("rejects ambiguous controls instead of copying a message or link", async () => {
    const page = nativePage({ duplicate: true });
    await expect(kimiAdapter.copyNative({ document: page.document, url })).rejects.toThrow(/changed or is unavailable/);
    expect(page.copy.click).not.toHaveBeenCalled();
  });
  it("does not report success without a fresh native completion signal", async () => {
    vi.useFakeTimers();
    try {
      const page = nativePage({ confirm: false });
      const pending = expect(kimiAdapter.copyNative({ document: page.document, url })).rejects.toThrow(/did not confirm/);
      await vi.runAllTimersAsync();
      await pending;
      expect(page.observers.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("uses the native branch without fetching, reading storage or overwriting native clipboard", async () => {
    const page = nativePage();
    const fetch = vi.fn(), writeText = vi.fn();
    const storage = new Proxy({}, { get() { throw Error("Storage read"); } });
    const result = await copyCurrentConversation({ adapter: kimiAdapter, url, document: page.document, fetch, storage, writeText });
    expect(result).toMatchObject({ ok: true, platform: "kimi", source: "native" });
    expect(fetch).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
  it("waits for popup focus to return to the page before invoking native clipboard code", async () => {
    const p = nativePage();
    let focused = false;
    const listeners = new Map();
    p.document.hasFocus = () => focused;
    p.document.defaultView.addEventListener = (name, cb) => listeners.set(name, cb);
    p.document.defaultView.removeEventListener = (name) => listeners.delete(name);
    p.document.addEventListener = (name, cb) => listeners.set(name, cb);
    p.document.removeEventListener = (name) => listeners.delete(name);
    const pending = copyCurrentConversation({ adapter: kimiAdapter, url, document: p.document });
    expect(p.copy.click).not.toHaveBeenCalled();
    focused = true;
    listeners.get("focus")();
    expect(await pending).toMatchObject({ ok: true, source: "native" });
    expect(listeners.size).toBe(0);
  });
});
