import { COPY_MESSAGE } from "../core/copy.js";
import { adapterForUrl, isSupportedUrl } from "../platforms/registry.js";

async function sendCopyMessage() {
  const status = document.getElementById("status");
  status.textContent = "Copying...";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return void (status.textContent = "No active tab found.");
  if (!isSupportedUrl(tab.url || "")) return void (status.textContent = "Open a saved conversation on a supported AI chat site first.");
  try {
    const native = Boolean(adapterForUrl(tab.url || "")?.copyNative);
    const message = { type: COPY_MESSAGE, ...(native ? { handoff: true } : {}) };
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, message);
    } catch (_error) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      response = await chrome.tabs.sendMessage(tab.id, message);
    }
    if (native && response?.accepted) return window.close();
    status.textContent = response?.ok
      ? response.source === "native" ? response.message : `Copied ${response.messages.toLocaleString()} messages and ${response.characters.toLocaleString()} characters from ${response.platform}.`
      : response?.error || "Could not copy this conversation.";
  } catch (error) {
    status.textContent = error?.message || "Could not copy this conversation.";
  }
}

document.getElementById("copy").addEventListener("click", () => sendCopyMessage());
