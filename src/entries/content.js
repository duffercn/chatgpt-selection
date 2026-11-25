import { COPY_MESSAGE, WRITE_CLIPBOARD_MESSAGE, copyCurrentConversation } from "../core/copy.js";
import { CopyError, ErrorCode } from "../core/errors.js";
import { adapterForUrl } from "../platforms/registry.js";

import { positionButton } from "../core/placement.js";

const VERSION = "0.6.0";
const BUTTON_ID = "cgca-copy-current-conversation";
const DEFAULT_LABEL = "Copy chat";

if (window.__chatCopyAllLoaded !== VERSION) {
  window.__chatCopyAllLoaded = VERSION;

  let placementFrame = 0;
  function schedulePlacement() {
    if (placementFrame) return;
    placementFrame = requestAnimationFrame(() => {
      placementFrame = 0;
      const button = document.getElementById(BUTTON_ID);
      if (button) positionButton(button);
    });
  }
  const resizeObserver = new ResizeObserver(schedulePlacement);
  resizeObserver.observe(document.documentElement);
  window.addEventListener("resize", schedulePlacement);
  window.addEventListener("scroll", schedulePlacement, true);

  function setButtonState(label, state = "", resetAfter = 1800) {
    const button = document.getElementById(BUTTON_ID);
    if (!button) return;
    button.textContent = label;
    button.dataset.state = state;
    schedulePlacement();
    if (resetAfter) window.setTimeout(() => {
      button.textContent = DEFAULT_LABEL;
      button.dataset.state = "";
      schedulePlacement();
    }, resetAfter);
  }

  async function runCopy() {
    setButtonState("Loading...", "busy", 0);
    const result = await copyCurrentConversation({
      adapter: adapterForUrl(location.href),
      url: location.href,
      fetch: window.fetch.bind(window),
      storage: window.localStorage,
      document,
      navigator,
      writeText: async (text) => {
        const response = await chrome.runtime.sendMessage({ type: WRITE_CLIPBOARD_MESSAGE, text });
        if (!response?.ok) throw new CopyError(ErrorCode.CLIPBOARD_FAILED, response?.error || "Could not write to the clipboard.");
      }
    });
    const button = document.getElementById(BUTTON_ID);
    if (button) {
      button.dataset.errorCode = result.ok ? "" : result.code || "unknown";
      button.title = result.ok ? "Copy the current conversation" : `${result.code || "error"}: ${result.error}`;
    }
    if (!result.ok) console.warn("ChatCopy:", result.code, result.error);
    setButtonState(result.ok ? result.action === "download" ? "Export requested" : "Copied" : `Failed: ${result.code || "error"}`, result.ok ? "ok" : "error", result.ok ? 1800 : 5000);
    return result;
  }

  function addButton() {
    if (document.getElementById(BUTTON_ID) || !adapterForUrl(location.href)) return;
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.dataset.version = VERSION;
    button.className = "cgca-copy-button";
    button.type = "button";
    button.textContent = DEFAULT_LABEL;
    button.title = "Copy the current conversation";
    button.addEventListener("click", () => runCopy());
    document.documentElement.appendChild(button);
    resizeObserver.observe(button);
    schedulePlacement();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== COPY_MESSAGE) return false;
    if (message.nativeGestureHint && adapterForUrl(location.href)?.id === "kimi") {
      setButtonState("Click to copy", "", 5000);
      document.getElementById(BUTTON_ID)?.setAttribute("title", "Click this button to use Kimi's native clipboard copy.");
      sendResponse({ ok: false, code: ErrorCode.CLIPBOARD_FAILED, error: "Kimi's native clipboard copy requires a page click. Click Copy chat." });
      return false;
    }
    if (message.handoff && adapterForUrl(location.href)?.copyNative) {
      // Acknowledge receipt, then let the popup close and return focus before
      // the website's own clipboard / export code runs. The page button keeps
      // displaying the actual result, including native failures.
      void runCopy();
      sendResponse({ accepted: true });
      return false;
    }
    runCopy().then(sendResponse);
    return true;
  });

  addButton();
  new MutationObserver(() => { addButton(); schedulePlacement(); }).observe(document.documentElement, { childList: true, subtree: true });
}
