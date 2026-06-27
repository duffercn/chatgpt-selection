(function () {
  const SCRIPT_VERSION = "0.2.2";
  if (window.__chatgptCopyAllLoaded === SCRIPT_VERSION) return;
  window.__chatgptCopyAllLoaded = SCRIPT_VERSION;

  const BUTTON_ID = "cgca-copy-chatgpt-conversation";
  const DEFAULT_LABEL = "Copy chat";

  function cleanText(text) {
    return text
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function roleLabel(role) {
    if (role === "user") return "User";
    if (role === "assistant") return "ChatGPT";
    if (role === "tool") return "Tool";
    return role ? role[0].toUpperCase() + role.slice(1) : "Message";
  }

  function getConversationIdFromUrl() {
    const parts = location.pathname.split("/").filter(Boolean);
    const cIndex = parts.indexOf("c");
    if (cIndex >= 0 && parts[cIndex + 1]) return parts[cIndex + 1];

    const uuidLike = parts.find((part) => {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part);
    });
    return uuidLike || "";
  }

  function getBackendConversationUrl(conversationId) {
    return `${location.origin}/backend-api/conversation/${encodeURIComponent(conversationId)}`;
  }

  function extractPartText(part) {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    if (typeof part.content === "string") return part.content;
    if (typeof part.name === "string" && part.content_type) return `[${part.content_type}: ${part.name}]`;
    if (typeof part.content_type === "string" && part.content_type.includes("image")) return "[Image]";
    return "";
  }

  function extractMessageText(message) {
    const content = message?.content;
    if (!content) return "";
    if (typeof content === "string") return cleanText(content);
    if (typeof content.text === "string") return cleanText(content.text);
    if (typeof content.result === "string") return cleanText(content.result);
    if (Array.isArray(content.parts)) {
      return cleanText(content.parts.map(extractPartText).filter(Boolean).join("\n\n"));
    }
    return "";
  }

  function messagesFromConversationJson(data) {
    const mapping = data?.mapping;
    if (!mapping || typeof mapping !== "object") return [];

    const children = {};
    for (const [id, node] of Object.entries(mapping)) {
      if (node?.parent && id) {
        if (!children[node.parent]) children[node.parent] = [];
        children[node.parent].push(id);
      }
    }

    function nodeToMessage(node) {
      const message = node?.message;
      const role = message?.author?.role || "";
      if (!["user", "assistant"].includes(role)) return null;
      if (message?.metadata?.is_visually_hidden_from_conversation) return null;
      const text = extractMessageText(message);
      return text ? { role, text, createTime: message?.create_time || 0 } : null;
    }

    function pathMessagesFromLeaf(leafId) {
      const path = [];
      const seen = new Set();
      let nodeId = leafId;
      while (nodeId && mapping[nodeId] && !seen.has(nodeId)) {
        seen.add(nodeId);
        path.push(mapping[nodeId]);
        nodeId = mapping[nodeId].parent;
      }

      return path
        .reverse()
        .map(nodeToMessage)
        .filter(Boolean);
    }

    function messageMatches(anchor, candidate) {
      if (!anchor || !candidate || anchor.role !== candidate.role) return false;
      const a = cleanText(anchor.text).slice(0, 700);
      const b = cleanText(candidate.text).slice(0, 700);
      return a.includes(b) || b.includes(a) || a.slice(0, 160) === b.slice(0, 160);
    }

    function scorePath(messages, anchors) {
      let score = messages.length;
      let cursor = 0;
      for (const anchor of anchors) {
        for (let index = cursor; index < messages.length; index += 1) {
          if (messageMatches(anchor, messages[index])) {
            score += 1000;
            cursor = index + 1;
            break;
          }
        }
      }
      score += Math.max(0, ...messages.map((message) => message.createTime || 0)) / 100000000;
      return score;
    }

    const leaves = Object.keys(mapping).filter((id) => {
      return mapping[id]?.message && (!children[id] || children[id].length === 0);
    });
    if (!leaves.length && data.current_node && mapping[data.current_node]) {
      leaves.push(data.current_node);
    }

    const anchors = getCurrentMessages().slice(-12);
    let bestMessages = [];
    let bestScore = -Infinity;
    for (const leafId of leaves) {
      const messages = pathMessagesFromLeaf(leafId);
      if (!messages.length) continue;
      const score = scorePath(messages, anchors);
      if (score > bestScore) {
        bestScore = score;
        bestMessages = messages;
      }
    }

    return bestMessages.map(({ role, text }) => ({ role, text }));
  }

  let cachedAccessToken = "";
  async function getAccessToken() {
    if (cachedAccessToken) return cachedAccessToken;
    try {
      const response = await fetch(`${location.origin}/api/auth/session`, {
        credentials: "include",
        headers: { accept: "application/json" }
      });
      if (!response.ok) return "";
      const data = await response.json();
      cachedAccessToken = data?.accessToken || "";
    } catch (_error) {
      cachedAccessToken = "";
    }
    return cachedAccessToken;
  }

  async function getMessagesFromBackend() {
    const conversationId = getConversationIdFromUrl();
    if (!conversationId) return [];

    const headers = { accept: "application/json" };
    const token = await getAccessToken();
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetch(getBackendConversationUrl(conversationId), {
      credentials: "include",
      headers
    });
    if (!response.ok) {
      throw new Error(`Conversation API returned ${response.status}`);
    }

    const data = await response.json();
    return messagesFromConversationJson(data);
  }

  function stripControls(root) {
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll(
        [
          "button",
          "svg",
          "[hidden]",
          "[aria-hidden='true']",
          "[role='button']",
          "[aria-label*='Copy']",
          "[aria-label*='copy']",
          "[data-testid*='copy']",
          "[contenteditable='true']",
          "textarea",
          "input"
        ].join(",")
      )
      .forEach((node) => node.remove());
    return cleanText(clone.innerText || clone.textContent || "");
  }

  function getConversationRoot() {
    return document.querySelector("main") || document.body;
  }

  function isRendered(node) {
    if (!(node instanceof Element) || !node.isConnected) return false;
    if (node.closest("#" + BUTTON_ID)) return false;
    if (node.closest("[hidden], [aria-hidden='true']")) return false;

    let current = node;
    while (current && current instanceof Element && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      current = current.parentElement;
    }

    return node.getClientRects().length > 0;
  }

  function isInViewport(node) {
    if (!isRendered(node)) return false;
    const rects = [...node.getClientRects()];
    return rects.some((rect) => {
      return rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    });
  }

  function getMessagesByRole() {
    const root = getConversationRoot();
    const nodes = [...root.querySelectorAll("[data-message-author-role]")];
    return nodes
      .map((node) => {
        if (!isRendered(node)) return null;
        const role = node.getAttribute("data-message-author-role");
        const text = stripControls(node);
        return text ? { role, text } : null;
      })
      .filter(Boolean);
  }

  function getMessagesByConversationTurns() {
    const root = getConversationRoot();
    const selectors = [
      "[data-testid^='conversation-turn']",
      "article",
      "main [class*='group/conversation-turn']"
    ];
    const seen = new Set();
    const turns = [];

    for (const selector of selectors) {
      for (const node of root.querySelectorAll(selector)) {
        if (seen.has(node) || !isRendered(node)) continue;
        seen.add(node);
        const text = stripControls(node);
        if (text) turns.push({ role: inferRole(node, turns.length), text });
      }
      if (turns.length) break;
    }

    return turns.filter((turn) => !looksLikeBranchChrome(turn.text));
  }

  function looksLikeBranchChrome(text) {
    const compact = cleanText(text).toLowerCase();
    return /^(previous|next|branch|edit|copy|good response|bad response|retry|regenerate|share|more)$/.test(compact);
  }

  function inferRole(node, index) {
    const labelled = node.querySelector("[data-message-author-role]");
    if (labelled) return labelled.getAttribute("data-message-author-role");

    const text = (node.getAttribute("aria-label") || node.textContent || "").toLowerCase();
    if (text.includes("chatgpt") || text.includes("assistant")) return "assistant";
    if (text.includes("you") || text.includes("user")) return "user";

    return index % 2 === 0 ? "user" : "assistant";
  }

  function getCurrentMessages() {
    const roleMessages = getMessagesByRole();
    const turnMessages = getMessagesByConversationTurns();
    if (!roleMessages.length) return turnMessages;

    const supplementalTurns = turnMessages.filter((turn) => {
      return !roleMessages.some((message) => {
        return message.text.includes(turn.text) || turn.text.includes(message.text);
      });
    });

    return [...roleMessages, ...supplementalTurns];
  }

  function getVisibleViewportMessages() {
    const root = getConversationRoot();
    const toMessage = (node, index) => {
      const role = node.getAttribute("data-message-author-role") || inferRole(node, index);
      const text = stripControls(node);
      return text && !looksLikeBranchChrome(text) ? { role, text } : null;
    };
    const byTop = (a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return aRect.top - bRect.top;
    };

    const roleMessages = [...root.querySelectorAll("[data-message-author-role]")]
      .filter(isInViewport)
      .sort(byTop)
      .map(toMessage)
      .filter(Boolean);

    const turnSelectors = [
      "[data-testid^='conversation-turn']",
      "article",
      "main [class*='group/conversation-turn']"
    ];
    const seen = new Set();
    const turnMessages = [];

    for (const selector of turnSelectors) {
      for (const node of root.querySelectorAll(selector)) {
        if (seen.has(node) || !isInViewport(node)) continue;
        seen.add(node);
        const message = toMessage(node, turnMessages.length);
        if (message) turnMessages.push(message);
      }
    }

    const supplementalTurns = turnMessages.filter((turn) => {
      return !roleMessages.some((message) => {
        return message.text.includes(turn.text) || turn.text.includes(message.text);
      })
    });

    return [...roleMessages, ...supplementalTurns];
  }

  function addMessages(messages, store) {
    let added = 0;
    for (const message of messages) {
      const key = `${message.role}\n${message.text}`;
      if (!store.seen.has(key)) {
        store.seen.add(key);
        store.messages.push(message);
        added += 1;
      }
    }
    return added;
  }

  function buildTranscript(messages) {
    const unique = [];
    const seen = new Set();
    for (const message of messages) {
      const key = `${message.role}\n${message.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(message);
      }
    }

    if (!unique.length) {
      const main = document.querySelector("main") || document.body;
      const text = stripControls(main);
      if (text) unique.push({ role: "conversation", text });
    }

    return unique
      .map((message) => `${roleLabel(message.role)}:\n${message.text}`)
      .join("\n\n---\n\n");
  }

  function getScrollTop(container) {
    return container === document.scrollingElement
      ? window.scrollY || container.scrollTop
      : container.scrollTop;
  }

  function getScrollHeight(container) {
    return container === document.scrollingElement
      ? Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
      : container.scrollHeight;
  }

  function getClientHeight(container) {
    return container === document.scrollingElement
      ? window.innerHeight
      : container.clientHeight;
  }

  function scrollToTop(container, top) {
    if (container === document.scrollingElement) {
      window.scrollTo(0, top);
    } else {
      container.scrollTop = top;
    }
  }

  function scrollToBottom(container) {
    scrollToTop(container, getScrollHeight(container));
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function findScrollContainer() {
    const root = document.scrollingElement || document.documentElement;
    const main = document.querySelector("main");
    const candidates = [root, document.body, document.documentElement, ...document.querySelectorAll("body *")];
    let best = root;
    let bestScore = getScrollHeight(root) - getClientHeight(root);

    for (const node of candidates) {
      if (!(node instanceof Element)) continue;
      const overflow = node.scrollHeight - node.clientHeight;
      if (overflow < 200) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < window.innerWidth * 0.35 || rect.height < window.innerHeight * 0.35) continue;
      const style = window.getComputedStyle(node);
      if (!/(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`) && node !== root) continue;
      const mainBonus = main && (node.contains(main) || main.contains(node)) ? 100000 : 0;
      const viewportBonus = rect.height >= window.innerHeight * 0.75 ? 50000 : 0;
      const score = overflow + mainBonus + viewportBonus;
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }

    return best;
  }

  async function settleAfterScroll(container) {
    let previousHeight = getScrollHeight(container);
    await wait(180);
    for (let index = 0; index < 6; index += 1) {
      const currentHeight = getScrollHeight(container);
      if (Math.abs(currentHeight - previousHeight) < 8) return;
      previousHeight = currentHeight;
      await wait(180);
    }
  }

  function getContainerTop(container) {
    if (container === document.scrollingElement) return 0;
    return container.getBoundingClientRect().top;
  }

  // Stable identity for a rendered message. ChatGPT tags each message node with
  // a UUID in data-message-id, which survives virtualization re-renders. Falls
  // back to role + a text prefix when the id is unavailable.
  function messageKey(node, role, text) {
    const id =
      (node.getAttribute && node.getAttribute("data-message-id")) ||
      (node.querySelector && node.querySelector("[data-message-id]")?.getAttribute("data-message-id"));
    if (id) return "id:" + id;
    return "rt:" + role + "\n" + cleanText(text).slice(0, 120);
  }

  // Snapshot of currently rendered messages, each tagged with a global Y
  // coordinate (scroll offset + position within the container) so the final
  // transcript can be ordered by true page position rather than scan order.
  function collectMessagesSnapshot(container) {
    const root = getConversationRoot();
    const scrolled = getScrollTop(container);
    const containerTop = getContainerTop(container);

    let nodes = [...root.querySelectorAll("[data-message-author-role]")];
    if (!nodes.length) {
      for (const selector of [
        "[data-testid^='conversation-turn']",
        "article",
        "main [class*='group/conversation-turn']"
      ]) {
        nodes = [...root.querySelectorAll(selector)];
        if (nodes.length) break;
      }
    }

    const out = [];
    nodes.forEach((node, index) => {
      if (!isRendered(node)) return;
      const role = node.getAttribute("data-message-author-role") || inferRole(node, index);
      const text = stripControls(node);
      if (!text || looksLikeBranchChrome(text)) return;
      const rectTop = node.getBoundingClientRect().top - containerTop;
      out.push({ role, text, key: messageKey(node, role, text), y: scrolled + rectTop });
    });
    return out;
  }

  async function scanConversation(button) {
    const container = findScrollContainer();
    const originalTop = getScrollTop(container);
    const collected = new Map(); // key -> { role, text, y }

    const absorb = () => {
      for (const message of collectMessagesSnapshot(container)) {
        const existing = collected.get(message.key);
        if (!existing) {
          collected.set(message.key, { role: message.role, text: message.text, y: message.y });
        } else if (message.text.length > existing.text.length) {
          // Keep the most complete render; keep the first stable y for ordering.
          existing.text = message.text;
        }
      }
    };

    setButtonState(button, "Scanning...", "busy", 0);

    // Grab whatever is on screen first (usually the latest messages at the bottom).
    absorb();

    scrollToTop(container, 0);
    await settleAfterScroll(container);
    absorb();

    const stepSize = Math.max(420, Math.floor(getClientHeight(container) * 0.72));
    let steps = 0;
    let lastTop = -1;
    let stuckCount = 0;

    while (steps < 1200) {
      const top = getScrollTop(container);
      const maxTop = Math.max(0, getScrollHeight(container) - getClientHeight(container));

      if (button) button.textContent = `Scanning ${collected.size}`;
      absorb();

      if (top >= maxTop - 8) break;

      scrollToTop(container, Math.min(maxTop, top + stepSize));
      await settleAfterScroll(container);

      const newTop = getScrollTop(container);
      if (Math.abs(newTop - lastTop) < 4) {
        stuckCount += 1;
        if (stuckCount > 4) break;
      } else {
        stuckCount = 0;
      }
      lastTop = newTop;
      steps += 1;
    }

    // Drive all the way to the bottom and dwell, so the final turns get rendered.
    for (let index = 0; index < 8; index += 1) {
      scrollToBottom(container);
      await settleAfterScroll(container);
      absorb();

      const top = getScrollTop(container);
      const maxTop = Math.max(0, getScrollHeight(container) - getClientHeight(container));
      if (top >= maxTop - 8) break;
      await wait(220);
    }

    // Re-sweep the last few screens to catch any tail messages still virtualized.
    const tailStep = Math.max(260, Math.floor(getClientHeight(container) * 0.45));
    for (let index = 3; index >= 0; index -= 1) {
      const maxTop = Math.max(0, getScrollHeight(container) - getClientHeight(container));
      scrollToTop(container, Math.max(0, maxTop - tailStep * index));
      await settleAfterScroll(container);
      absorb();
    }

    scrollToTop(container, originalTop);

    return [...collected.values()]
      .sort((a, b) => a.y - b.y)
      .map(({ role, text }) => ({ role, text }));
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (_error) {
        // Fall back below. Long scans can outlive the browser's user-activation window.
      }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }

  function setButtonState(button, label, state, resetAfter = 1600) {
    if (!button) return;
    button.textContent = label;
    button.dataset.state = state || "";
    if (resetAfter > 0) {
      window.setTimeout(() => {
        button.textContent = DEFAULT_LABEL;
        button.dataset.state = "";
      }, resetAfter);
    }
  }

  async function copyConversation(sourceButton) {
    let messages = [];
    let source = "api";

    try {
      setButtonState(sourceButton, "Loading data...", "busy", 0);
      messages = await getMessagesFromBackend();
    } catch (_error) {
      messages = [];
    }

    if (!messages.length) {
      source = "dom";
      messages = await scanConversation(sourceButton);
    }

    const transcript = buildTranscript(messages);
    if (!transcript) {
      if (sourceButton) setButtonState(sourceButton, "Nothing found", "error");
      return { ok: false, error: "No conversation text found." };
    }

    try {
      await copyText(transcript);
      setButtonState(sourceButton, source === "api" ? "Copied API" : "Copied DOM", "ok");
      return { ok: true, characters: transcript.length, messages: messages.length, source };
    } catch (error) {
      setButtonState(sourceButton, "Copy failed", "error");
      return { ok: false, error: error?.message || String(error) };
    }
  }

  function addButton() {
    const existingButton = document.getElementById(BUTTON_ID);
    if (existingButton?.dataset.version === SCRIPT_VERSION) return;
    if (existingButton) existingButton.remove();
    if (!location.hostname.includes("chatgpt.com") && !location.hostname.includes("chat.openai.com")) return;

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.dataset.version = SCRIPT_VERSION;
    button.className = "cgca-copy-button";
    button.type = "button";
    button.textContent = DEFAULT_LABEL;
    button.title = `Copy the current ChatGPT conversation (${SCRIPT_VERSION})`;
    button.addEventListener("click", () => copyConversation(button));
    document.documentElement.appendChild(button);
  }

  chrome.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "CHATGPT_COPY_ALL_V2") return false;
    copyConversation(document.getElementById(BUTTON_ID)).then(sendResponse);
    return true;
  });

  addButton();

  const observer = new MutationObserver(addButton);
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
