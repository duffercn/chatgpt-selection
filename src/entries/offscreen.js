chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "OFFSCREEN_WRITE_CLIPBOARD_V3") return false;
  (async () => {
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(message.text);
          return { ok: true };
        } catch (_error) {
          // Offscreen documents are not focusable in some Chrome versions.
          // Fall through to execCommand, which is the supported MV3 fallback.
        }
      }
      const textarea = document.createElement("textarea");
      textarea.value = message.text;
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied ? { ok: true } : { ok: false, error: "Chrome rejected the clipboard write." };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  })().then(sendResponse);
  return true;
});
