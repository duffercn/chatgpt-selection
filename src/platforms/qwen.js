import { CopyError, ErrorCode } from "../core/errors.js";

const unavailable = (text) => new CopyError(ErrorCode.API_UNAVAILABLE, `Qwen native export: ${text}`);
const label = (node) => String(node.textContent || "").replace(/\s+/g, " ").trim();

function control(document, selector, text) {
  const nodes = [...document.querySelectorAll(selector)].filter((node) => node.getClientRects().length && !node.closest('[hidden], [aria-hidden="true"]') && (!text || label(node) === text));
  if (nodes.length > 1) throw unavailable("The native export control is ambiguous.");
  return nodes[0];
}

function waitControl(document, selector, text) {
  return new Promise((resolve, reject) => {
    let observer, timer;
    const finish = (error, node) => { observer?.disconnect(); clearTimeout(timer); error ? reject(error) : resolve(node); };
    const inspect = () => { try { const node = control(document, selector, text); if (node) finish(null, node); } catch (error) { finish(error); } };
    observer = new document.defaultView.MutationObserver(inspect);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    timer = setTimeout(() => finish(unavailable(`The native ${text} option is unavailable. Open the conversation menu and try again.`)), 5000);
    inspect();
  });
}

// Reuses the verified whole-conversation TXT export. It never reads chat bodies
// or turns the native file download into an unverified clipboard success.
export const qwenAdapter = {
  id: "qwen",
  matches(url) {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "chat.qwen.ai" && /^\/c\/[\w-]+\/?$/.test(parsed.pathname);
  },
  async copyNative({ document, url }) {
    if (!this.matches(url)) throw unavailable("Open a saved conversation first.");
    const more = control(document, 'button[aria-label="More"]');
    if (!more) throw unavailable("The conversation menu changed or is unavailable.");
    const menuItems = '[role="menu"] [role="menuitem"]';
    let text = control(document, menuItems, "Plain text (.txt)");
    if (!text) {
      let download = control(document, menuItems, "Download");
      if (!download) {
        more.click();
        download = await waitControl(document, menuItems, "Download");
      }
      // This is a native hover submenu: clicking alone leaves it closed.
      download.dispatchEvent(new document.defaultView.PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
      download.dispatchEvent(new document.defaultView.MouseEvent("mouseover", { bubbles: true }));
      download.click();
      text = await waitControl(document, menuItems, "Plain text (.txt)");
    }
    text.click();
    return { ok: true, platform: "qwen", source: "native", action: "download", message: "Qwen native TXT export requested. Check your browser downloads." };
  }
};
