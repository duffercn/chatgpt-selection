// Shipping adapters for 0.6.0.
//
// Scope was deliberately narrowed to these five platforms so each one can be
// verified end to end. The adapters for Perplexity, Qianwen, Kimi, Qwen and
// Gemini are intentionally kept in this directory — with their tests — but are
// no longer registered or matched. Nothing ships that is not acceptance-tested;
// re-enabling one is a matter of importing it here and restoring its hosts in
// manifest.json.
import { chatGptAdapter } from "./chatgpt.js";
import { claudeAdapter } from "./claude.js";
import { grokAdapter } from "./grok.js";
import { deepSeekAdapter } from "./deepseek.js";
import { doubaoAdapter } from "./doubao.js";

export const adapters = [chatGptAdapter, claudeAdapter, grokAdapter, deepSeekAdapter, doubaoAdapter];

export function adapterForUrl(url) {
  try { return adapters.find((adapter) => adapter.matches(url)) || null; }
  catch (_error) { return null; }
}

export function isSupportedUrl(url) { return Boolean(adapterForUrl(url)); }
