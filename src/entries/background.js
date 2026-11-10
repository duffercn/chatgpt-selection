import { COPY_MESSAGE, WRITE_CLIPBOARD_MESSAGE } from "../core/copy.js";
import { adapterForUrl, isSupportedUrl } from "../platforms/registry.js";

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "copy-current-conversation") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isSupportedUrl(tab.url || "")) return;
  const message = { type: COPY_MESSAGE, ...(adapterForUrl(tab.url || "")?.id === "kimi" ? { nativeGestureHint: true } : {}) };
  chrome.tabs.sendMessage(tab.id, message).catch(() => {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).then(() => {
      chrome.tabs.sendMessage(tab.id, message);
    });
  });
});

async function ensureOffscreenDocument() {
  const path = "offscreen.html";
  const url = chrome.runtime.getURL(path);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: path,
    reasons: ["CLIPBOARD"],
    justification: "Copy the locally extracted conversation to the clipboard."
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== WRITE_CLIPBOARD_MESSAGE) return false;
  ensureOffscreenDocument()
    .then(() => chrome.runtime.sendMessage({ type: "OFFSCREEN_WRITE_CLIPBOARD_V3", text: message.text }))
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
