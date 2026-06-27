async function sendCopyMessage() {
  const status = document.getElementById("status");
  status.textContent = "Copying...";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    status.textContent = "No active tab found.";
    return;
  }

  if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url || "")) {
    status.textContent = "Open a ChatGPT tab first.";
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "CHATGPT_COPY_ALL_V2" });
    status.textContent = response?.ok
      ? `Copied ${response.messages.toLocaleString()} messages, ${response.characters.toLocaleString()} characters via ${response.source}.`
      : response?.error || "Could not copy this chat.";
  } catch (_error) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "CHATGPT_COPY_ALL_V2" });
    status.textContent = response?.ok
      ? `Copied ${response.messages.toLocaleString()} messages, ${response.characters.toLocaleString()} characters via ${response.source}.`
      : response?.error || "Could not copy this chat.";
  }
}

document.getElementById("copy").addEventListener("click", sendCopyMessage);
