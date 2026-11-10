import { chatGptAdapter } from "./chatgpt.js";
import { claudeAdapter } from "./claude.js";
import { grokAdapter } from "./grok.js";
import { deepSeekAdapter } from "./deepseek.js";
import { perplexityAdapter } from "./perplexity.js";
import { qianwenAdapter } from "./qianwen.js";
import { kimiAdapter } from "./kimi.js";
import { qwenAdapter } from "./qwen.js";
import { doubaoAdapter } from "./doubao.js";

import { geminiAdapter } from "./gemini.js";

export const adapters = [chatGptAdapter, claudeAdapter, grokAdapter, deepSeekAdapter, perplexityAdapter, qianwenAdapter, kimiAdapter, qwenAdapter, doubaoAdapter, geminiAdapter];

export function adapterForUrl(url) {
  try { return adapters.find((adapter) => adapter.matches(url)) || null; }
  catch (_error) { return null; }
}

export function isSupportedUrl(url) { return Boolean(adapterForUrl(url)); }
