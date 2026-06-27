chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "copy-chatgpt-conversation") return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  chrome.tabs.sendMessage(tab.id, { type: "CHATGPT_COPY_ALL_V2" }).catch(() => {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    }).then(() => {
      chrome.tabs.sendMessage(tab.id, { type: "CHATGPT_COPY_ALL_V2" });
    });
  });
});
