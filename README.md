# ChatGPT Copy All

A small Chrome extension that copies the current ChatGPT conversation with one click.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `/Users/ZhenLi/Project/chatgpt-selection`.

## Use

- Open a conversation on `chatgpt.com`.
- Click the floating **Copy chat** button in the bottom-right corner, or click the extension icon and choose **Copy current chat**.
- The default shortcut is `Ctrl+Shift+C` on Windows/Linux and `Command+Shift+C` on macOS. Chrome may require confirming or changing it at `chrome://extensions/shortcuts`.

## Notes

For long conversations, the extension first tries to read ChatGPT's conversation data for the current chat and selected branch. If that is unavailable, it falls back to scrolling through the page to collect messages that ChatGPT has virtualized or unloaded. Very long fallback scans can take a little while; the floating button shows progress while it scans.

If a conversation has branches, the extension copies the currently selected visible branch path only.
