# Chat Copy All

A local-first Chrome extension that copies the complete current conversation from supported AI chat sites.

## Supported sites

- ChatGPT: `chatgpt.com` and `chat.openai.com`
- Claude: `claude.ai`
- Grok: `grok.com`
- DeepSeek: `chat.deepseek.com`

Native page-wide copy was also verified for the current Gemini, Kimi, Qwen, Tencent Yuanbao, and Perplexity Search web apps. Those sites are not included in the extension while their built-in copy remains complete and stable.

The extension reads the active conversation through each site's authenticated internal conversation API. It does not scroll the page, scrape rendered message text, upload conversation data, or store conversation data.

These internal APIs are not public compatibility contracts. A site update can require an adapter update. When a complete conversation cannot be identified, the extension reports an error instead of copying a partial or guessed transcript.

## Development

Requires Node.js 20 or newer.

```sh
npm install
npm test
npm run build
```

Load the generated `dist/` directory from `chrome://extensions` with Developer mode enabled. Create `release/chat-copy-all-0.4.0.zip` with `npm run package`.

## Use

- Open a saved conversation on a supported site.
- Click the floating **Copy chat** button, use **Copy current conversation** in the extension popup, or use `Ctrl+Shift+C` (`Command+Shift+C` on macOS).
- Text, Markdown, and code are preserved when supplied by the site API; unsupported images and files are represented by placeholders.

## Known limitations

- You must be signed in and allowed to access the conversation.
- New or temporary chats without a stable conversation ID cannot be copied.
- Shared conversation URLs are not part of the current MVP.
- Rich interactive artifacts and tool UIs are reduced to text or placeholders.
- Grok's authenticated endpoint and anti-bot behavior require real-browser verification after site changes.
- DeepSeek depends on a private authenticated web endpoint that can change without notice.
- Doubao's native page-wide copy is incomplete, but neither currently documented complete-conversation endpoint worked in the live signed-in page, so it is intentionally not claimed as supported.

## Architecture

Source lives in `src/`. Shared copy orchestration and formatting are separate from platform adapters. `esbuild` creates browser-ready bundles, and Vitest fixtures verify current-branch selection and response conversion without containing real conversation data.
