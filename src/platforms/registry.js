import { chatGptAdapter } from "./chatgpt.js";
import { claudeAdapter } from "./claude.js";
import { grokAdapter } from "./grok.js";
import { deepSeekAdapter } from "./deepseek.js";

export const adapters = [chatGptAdapter, claudeAdapter, grokAdapter, deepSeekAdapter];

export function adapterForUrl(url) {
  try { return adapters.find((adapter) => adapter.matches(url)) || null; }
  catch (_error) { return null; }
}

export function isSupportedUrl(url) { return Boolean(adapterForUrl(url)); }
