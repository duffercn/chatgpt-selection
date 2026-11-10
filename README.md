# Chat Copy All

A local-first Chrome extension that copies the complete current conversation from supported AI chat sites.

## Supported sites

- ChatGPT: `chatgpt.com` and `chat.openai.com`
- Claude: `claude.ai`
- Grok: `grok.com`
- Gemini: `gemini.google.com/app/{id}`
- DeepSeek: `chat.deepseek.com`
- Perplexity Search: `www.perplexity.ai/session/{id}`
- Qianwen China: `www.qianwen.com/chat/{id}`
- Doubao China: `www.doubao.com/chat/{id}`
- Kimi: `kimi.com/chat/{id}`, reuses native whole-conversation copy
- Qwen Global: `chat.qwen.ai/c/{id}`, reuses native TXT export

Before adding a site, we check its native whole-conversation copy or export. Reliable native features are reused behind the same page button. Browser Select All and copying a single answer do not establish whole-conversation support.

Kimi's button runs **Share → Select all → Copy text** and waits for a fresh native completion notice. The popup hands control back to the page so the site's clipboard code has focus. Kimi's keyboard shortcut asks you to click the page button: the native clipboard action needs that page gesture. No conversation-body DOM extraction or clipboard read permission is used.

Qwen Global's button runs **More → Download → Plain text (.txt)**. It requests a native file download and says **Export requested**, rather than claiming that text reached the clipboard.

Live five-turn button/popup/shortcut paste checks passed for ChatGPT, Claude, Grok, DeepSeek, Perplexity, Qianwen China and Gemini. Doubao's new adapter passed all three entrances with five user/assistant pairs, Chinese, code and long text. Kimi's native page button and popup passed real clipboard checks; Qwen Global's page button produced a TXT file identical to the manually verified native export. These results do not establish every attachment, branch or pagination scenario.

API adapters read the active conversation through the site's authenticated internal API. Native adapters operate only the site's export/copy controls. The extension does not scroll or scrape rendered chat bodies, upload conversations, or store conversation data. Yuanbao, ChatGLM, Z.ai and Dola have no extension adapter in this build. Gemini uses its observed history RPC for plaintext copy; its native PDF opens a print dialog and is not used for clipboard copying.

These internal APIs are not public compatibility contracts. A site update can require an adapter update. When a complete conversation cannot be identified, the extension reports an error instead of copying a partial or guessed transcript.

The unified copy action preserves roles, message order, Markdown and code as plain text for pasting into another chatbot. There is no separate TXT-file download button. Qwen Global remains a native TXT export exception, as described above.

## Development

Requires Node.js 20 or newer.

```sh
npm install
npm test
npm run build
```

Load the generated `dist/` directory from `chrome://extensions` with Developer mode enabled. Reload affected website tabs after reloading the unpacked extension. Create `release/chat-copy-all-0.5.4.zip` with `npm run package`.

## Use

- Open a saved conversation on a supported site.
- Click the floating **Copy chat** button, use **Copy current conversation** in the extension popup, or use `Ctrl+Shift+C` (`Command+Shift+C` on macOS).
- Text, Markdown, and code are preserved when supplied by the site API. Existing adapters represent supported attachment metadata with placeholders; the new Perplexity and Qianwen adapters reject unverified rich content.

## Known limitations

- You must be signed in and allowed to access the conversation.
- New or temporary chats without a stable conversation ID cannot be copied.
- Shared conversation URLs are not part of the current MVP.
- Rich interactive artifacts and tool UIs are reduced to text or placeholders.
- Grok's authenticated endpoint and anti-bot behavior require real-browser verification after site changes.
- DeepSeek depends on a private authenticated web endpoint that can change without notice.
- Perplexity's browser Select All truncates earlier turns at the bottom; native Markdown export omitted the original first user prompt. The adapter preserves the five-turn sample, but currently accepts only one complete page (request limit 20), with no fork, background work, snapshots, or unverified workflow items.
- Qianwen China currently accepts one complete page (request limit 10), one plain-text prompt and one completed Markdown answer per turn. Pagination, source cards, attachments, ambiguous answers and populated unverified follow-up blocks fail explicitly. Qwen Global is a separate product and uses its native TXT export wrapper.
- Doubao currently accepts one complete history page (limit 20), a verified active section and finished text blocks. Pagination, regeneration, documents, attachments and unknown rich blocks fail explicitly. The API's encoding headers are required; no stored device identifier or token is read.

- Gemini accepts complete plaintext history with one selected candidate per turn and a parent chain reaching the first turn. Pagination, attachments, unknown answer fields and ambiguous candidates fail explicitly. It uses the signed-in page's ephemeral bootstrap authentication in memory, without storing tokens or reading chat-body DOM.

## Architecture

Source lives in `src/`. Shared copy orchestration and formatting are separate from platform adapters. `esbuild` creates browser-ready bundles, and Vitest fixtures verify current-branch selection and response conversion without containing real conversation data.

## Branding draft

[Logo source and exports](assets/branding/README.md). Version 0.5.4 updates the icon. Product name remains Chat Copy All.

[Privacy policy](privacy-policy.md)
