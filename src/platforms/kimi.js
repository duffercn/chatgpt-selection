import { CopyError, ErrorCode } from "../core/errors.js";

const missing = (message) => new CopyError(ErrorCode.API_UNAVAILABLE, `Kimi native copy: ${message}`);
const normalize = (text) => String(text || "").replace(/\s+/g, " ").trim();

function unique(document, selector, label) {
  const nodes = [...document.querySelectorAll(selector)].filter((node) => node.getClientRects().length && !node.closest('[hidden], [aria-hidden="true"]'));
  if (nodes.length !== 1) throw missing(`${label} is unavailable or ambiguous. Open a saved conversation and try again.`);
  return nodes[0];
}

function waitFor(document, check, message, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let observer;
    let timer;
    const finish = (error, value) => { observer?.disconnect(); clearTimeout(timer); error ? reject(error) : resolve(value); };
    const inspect = () => { try { const value = check(); if (value) finish(null, value); } catch (error) { finish(error); } };
    observer = new document.defaultView.MutationObserver(inspect);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    timer = setTimeout(() => finish(missing(message)), timeout);
    inspect();
  });
}

// These selectors were inspected on Kimi's native Share / Select all / Copy text
// controls. No conversation body is read, selected, formatted, or persisted here.
export const kimiAdapter = {
  id: "kimi",
  matches(url) {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ["kimi.com", "www.kimi.com"].includes(parsed.hostname) && /^\/chat\/[\w-]+\/?$/.test(parsed.pathname);
  },
  async copyNative({ document, url }) {
    if (!this.matches(url)) throw missing("Open a saved conversation first.");
    if (!document.querySelector(".share-bottom-container")) {
      unique(document, '.chat-header-actions .icon:has(svg[name="Share_a"])', "Share control").click();
    }
    await waitFor(document, () => document.querySelector(".share-bottom-container"), "The native selection panel did not open.");
    const checkbox = unique(document, '.share-bottom-container .select-all input[type="checkbox"]', "Select all control");
    if (!checkbox.checked) {
      unique(document, ".share-bottom-container .select-all", "Select all control").click();
      await waitFor(document, () => checkbox.isConnected && checkbox.checked, "The site did not select the complete conversation.");
    }
    const buttons = [...document.querySelectorAll(".share-bottom-container .main-button")].filter((node) => node.getClientRects().length && normalize(node.textContent) === "Copy text");
    if (buttons.length !== 1) throw missing("The native Copy text control changed or is unavailable.");
    const success = () => [...document.querySelectorAll('.message-list-container, [role="status"], [role="alert"]')].find((node) => node.getClientRects().length && normalize(node.textContent) === "Text copied successfully");
    // A previous toast cannot confirm this operation. Wait for it to disappear.
    if (success()) await waitFor(document, () => !success(), "A previous copy notification did not clear.");
    const confirmed = waitFor(document, success, "The site did not confirm clipboard completion.");
    buttons[0].click();
    await confirmed;
    return { ok: true, platform: "kimi", source: "native", action: "copy", message: "Copied using Kimi's native conversation copy." };
  }
};
