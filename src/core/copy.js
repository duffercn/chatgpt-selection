import { CopyError, ErrorCode, toErrorResult } from "./errors.js";
import { formatConversation } from "./format.js";

export const COPY_MESSAGE = "COPY_CURRENT_CONVERSATION_V3";
export const WRITE_CLIPBOARD_MESSAGE = "WRITE_CHAT_COPY_CLIPBOARD_V3";

async function waitForNativeFocus(documentRef) {
  if (!documentRef?.hasFocus || documentRef.hasFocus()) return;
  await new Promise((resolve, reject) => {
    const windowRef = documentRef.defaultView;
    const finish = (error) => {
      clearTimeout(timer);
      windowRef.removeEventListener("focus", inspect);
      documentRef.removeEventListener("visibilitychange", inspect);
      error ? reject(error) : resolve();
    };
    const inspect = () => { if (documentRef.hasFocus()) finish(); };
    const timer = setTimeout(() => finish(new CopyError(ErrorCode.CLIPBOARD_FAILED, "Focus the conversation page and try again.")), 5000);
    windowRef.addEventListener("focus", inspect);
    documentRef.addEventListener("visibilitychange", inspect);
    inspect();
  });
}

export async function writeClipboard(text, documentRef = document, navigatorRef = navigator) {
  if (navigatorRef.clipboard?.writeText) {
    try {
      await navigatorRef.clipboard.writeText(text);
      return;
    } catch (_error) {
      // User activation may expire during a network request; use the local fallback.
    }
  }
  const textarea = documentRef.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  documentRef.body.appendChild(textarea);
  textarea.select();
  const copied = documentRef.execCommand("copy");
  textarea.remove();
  if (!copied) throw new CopyError(ErrorCode.CLIPBOARD_FAILED, "Could not write to the clipboard.");
}

export async function copyCurrentConversation({ adapter, url, fetch, storage, document, navigator, writeText }) {
  try {
    if (!adapter) throw new CopyError(ErrorCode.UNSUPPORTED_PLATFORM, "This site is not supported.");
    if (adapter.copyNative) {
      await waitForNativeFocus(document);
      const result = await adapter.copyNative({ url, document });
      if (result?.ok !== true || result.source !== "native" || !["copy", "download"].includes(result.action)) {
        throw new CopyError(ErrorCode.INVALID_RESPONSE, "The native conversation action did not confirm a result.");
      }
      return result;
    }
    const conversation = await adapter.extractConversation({ url, fetch, storage, document });
    if (!conversation.messages?.length) {
      throw new CopyError(ErrorCode.EMPTY_CONVERSATION, "No conversation messages were returned.");
    }
    const transcript = formatConversation(conversation);
    if (writeText) await writeText(transcript);
    else await writeClipboard(transcript, document, navigator);
    return {
      ok: true,
      platform: conversation.platform,
      messages: conversation.messages.length,
      characters: transcript.length,
      source: "api"
    };
  } catch (error) {
    return toErrorResult(error);
  }
}
