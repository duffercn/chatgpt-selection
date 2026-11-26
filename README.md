# ChatCopy

A local-first Chrome extension that copies the complete current conversation from supported AI chat sites as plain text with roles and Markdown intact.

## Supported sites in 0.7.0

| Site | URL pattern |
| --- | --- |
| ChatGPT | `chatgpt.com/c/{id}`, `chat.openai.com/c/{id}` |
| Claude | `claude.ai/chat/{id}` |
| Gemini | `gemini.google.com/app/{id}` (16 hex characters) |
| Grok | `grok.com` conversations |
| DeepSeek | `chat.deepseek.com/a/chat/s/{id}` |
| Doubao China | `doubao.com/chat/{id}`, `www.doubao.com/chat/{id}` |

The repository still contains adapters for Perplexity, Qianwen, Kimi and Qwen, together with their tests, but they are not registered and their hosts are not in the manifest. They do not ship in 0.7.0; re-enabling one means importing it in `src/platforms/registry.js` and restoring its host patterns in `manifest.json`.

## How it works

Every shipping adapter reads the saved conversation from the site's own authenticated API, using the session of the tab you are already signed in to. All parsing, branch selection and formatting happen locally in the extension. Nothing is uploaded, nothing is stored after the copy, and no conversation data leaves the browser. `src/platforms/registry.js` is the single list of enabled adapters.

No code from the page is executed. Rich components (generated UI, documents, widgets, media cards) are converted statically: the adapter reads their data fields and emits text or a marker. Nothing is fetched at copy time beyond the conversation payload itself.

These internal APIs are not public compatibility contracts, so a site update can require an adapter update. When the active conversation branch cannot be identified completely, the extension reports an error instead of copying a partial or guessed transcript.

## Output format

- One message is `Label:` followed by its body; messages are separated by a line of 20 `─` characters, which cannot collide with Markdown. Assistant labels are `ChatGPT`, `Claude`, `Gemini`, `Grok`, `DeepSeek` and `Doubao`; user turns are `User`.
- Markdown supplied by the API is kept: paragraphs, lists, tables, fenced code blocks, links.
- Only the active branch is copied, from the first turn to the selected leaf, in order and without duplicates.
- Rich content is marked:
  - `[Web search: query]` when the reply ran a web search; the line leads the message.
  - `([title](url))` inline where the reply cites a source.
  - `[Source: title](url)` for cited sources listed after the body. Only sources the reply actually cites are listed, in first-cited order, deduplicated by URL. Search results that were retrieved but never cited are not listed. Claude is the one exception: its sources stay in the body as a `Sources:` list.
  - `[Image]`, `[Image: caption](url)`, `[Video: caption · source](url)`, `[File]`, `[File: name]`, `[Attachment: name]` for media and uploads.
  - `[Chart: title]`, `[Diagram: labels]`, `[Gemini document: title]`, `[Doubao document: title]` and similar for generated artifacts, followed by the text the extension could reconstruct.
  - `[Unsupported content: …]` or a site-specific placeholder when a block type is unknown, so the content is never silently dropped. Doubao is stricter and refuses the whole copy when it meets an unverified rich block.
- Thinking and reasoning blocks, UI notices, disclaimers and suggested follow-ups are left out.
- Expiring or signed media URLs (signed `lh3` links, Doubao thumbnail/full-size links, private file handles) are never copied; only captions, titles and permanent page URLs survive. Tracking parameters are stripped from copied links.
- There is no TXT download button for the shipping six sites: the result always goes to the clipboard.

The authoritative per-site marker list lives in `vault/governance/standards/copy-output.md`.

## Why not select-all

Select-all copying on the page only captures the messages the site has rendered, and long conversations render only what is near the viewport. Measured on 2026-11-26 by comparing Cmd+A / Cmd+C output against the extension's output line by line:

| Conversation | Messages | Body lines reached | Messages entirely missing |
| --- | --- | --- | --- |
| ChatGPT, long | 116 | 6% | 101 |
| Claude, long | 75 | 1% | 63 |
| DeepSeek | 20 / 10 | 30% / 25% | 15 / 5 |
| Doubao | 6 / 10 | 93% / 28% | 1 / 3 |
| Grok | 18 / 12 | 44% / 75% | 9 / 2 |
| Gemini | 14 / 6 | 98% / 97% | 1 / 0 |

Select-all output never contained role labels, code fences, tables or links, and about half of the selected DeepSeek lines were page chrome (sidebars, buttons) rather than conversation. Only a one-turn ChatGPT conversation came through complete, and even then without roles or formatting.

Gemini is the exception in this sample: its conversations were short (at most 7 turns) and select-all reached 97–98% of the body text, but still with no role labels, no code fences (0 of 18) and no bold or other formatting. Longer Gemini conversations were not measured.

## Use

- Open a saved conversation on a supported site while signed in.
- Click the floating **Copy chat** button, or use **Copy current conversation** in the extension popup, or press `Ctrl+Shift+C` (`Command+Shift+C` on macOS).
- Paste wherever you need the transcript.

## Known limits

- You must be signed in with access to the conversation; new or temporary chats without a saved conversation ID cannot be copied.
- If the site changes an internal API, the adapter fails loudly until it is updated.
- Doubao refuses any conversation that has a regeneration branch or that is paginated (request limit 20 messages), and documents are copied as title plus preview only — the full text has to be opened in Doubao.
- Gemini refuses paginated history and answers whose candidate field it cannot identify. It reads only the ephemeral bootstrap token from the signed-in page, never chat DOM or storage.
- Grok depends on an authenticated endpoint plus anti-bot behaviour that needs real-browser verification after site changes.
- DeepSeek depends on a private authenticated web endpoint.
- Interactive artifacts, tool UIs and assistant "thinking" are reduced to text or placeholders; only the visible answer is copied.
- The floating button hides itself when no free space exists in the right gutter — narrow windows with dense sidebars can lose it. The popup and the keyboard shortcut still work.
- Shared conversation URLs are not part of the current scope.

## Development

Requires Node.js 20 or newer.

```sh
npm install
npm test
npm run build
```

`npm test` runs Vitest; `npm run build` writes the loadable extension to `dist/`.

### Optional real-data tests

Some tests replay conversations recorded from the live sites. Those recordings are private, live outside this repository and are never committed. Point one environment variable at their root directory to run them:

```sh
CHATCOPY_EVIDENCE=/path/to/private-evidence npm test
```

The directory holds `chatgpt-dil/`, `claude-rich/`, `doubao-rich/` and `survey/{chatgpt,claude,doubao,deepseek,grok}/`; the layout and the per-test entry points are documented in `tests/helpers/evidence.js`. Without the variable every such test is skipped, so the default `npm test` needs no private data.

### Architecture

Source lives in `src/`. `src/core/` holds copy orchestration, formatting and the shared rich-content helpers; `src/platforms/` holds one adapter plus its rich-content module per site. `esbuild` creates browser-ready bundles, and Vitest fixtures verify branch selection and response conversion without containing real conversation data.

## Load the extension

Load the generated `dist/` directory from `chrome://extensions` with Developer mode enabled. Reload affected website tabs after reloading the unpacked extension. `npm run package` builds and zips `dist/` into `release/chat-copy-all-0.7.0.zip`.

## Branding

[Logo source and exports](assets/branding/README.md). Product name: ChatCopy — Copy AI Conversations.

[Privacy policy](privacy-policy.md)
