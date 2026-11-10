import { cleanText } from "../core/content.js";
import { CopyError, ErrorCode, responseError } from "../core/errors.js";

// Observed on a real five-turn Perplexity Search conversation: the page issues
// this GET on load. Only cookies authenticate it; no signature/token was needed.
const THREAD_QUERY = "with_parent_info=true&with_schematized_response=true&version=2.18&source=default&limit=20&offset=0&from_first=false&with_first_entry=true&with_latest_entry=false&supported_block_use_cases=answer_modes&supported_block_use_cases=media_items&supported_block_use_cases=inline_entity_cards&supported_block_use_cases=place_widgets&supported_block_use_cases=finance_widgets&supported_block_use_cases=news_widgets&supported_block_use_cases=shopping_widgets&supported_block_use_cases=search_result_widgets&supported_block_use_cases=inline_images&supported_block_use_cases=inline_assets&supported_block_use_cases=placeholder_cards&supported_block_use_cases=diff_blocks&supported_block_use_cases=entity_group_v2&supported_block_use_cases=refinement_filters&supported_block_use_cases=canvas_mode&supported_block_use_cases=maps_preview&supported_block_use_cases=answer_tabs&supported_block_use_cases=preserve_latex&supported_block_use_cases=in_context_suggestions&supported_block_use_cases=pending_followups&supported_block_use_cases=inline_claims&supported_block_use_cases=unified_assets&supported_block_use_cases=workflow_steps&supported_block_use_cases=workflow_widgets&supported_block_use_cases=navigation_results&supported_block_use_cases=background_agents";

const WORKFLOW_BLOCK = "workflow_root";
const WORKFLOW_ITEM_TEXT = "WORKFLOW_ITEM_TEXT";
const ANSWER_VARIANT = "answer";

function invalid(message) {
  return new CopyError(ErrorCode.INVALID_RESPONSE, `Perplexity ${message}`);
}

function conversationId(url) {
  if (!["www.perplexity.ai", "perplexity.ai"].includes(new URL(url).hostname)) return "";
  return new URL(url).pathname.match(/^\/session\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i)?.[1] || "";
}

function requireAnswerText(payload, where) {
  if (!payload || typeof payload !== "object") throw invalid(`is missing the ${where} text payload; the conversation cannot be copied completely.`);
  if (payload.is_streaming !== false) throw invalid(`has an unfinished ${where} answer; wait for the response to finish and retry.`);
  if (payload.variant !== ANSWER_VARIANT) throw invalid(`has an unexpected ${where} payload variant "${String(payload.variant)}".`);
  if (typeof payload.text !== "string" || !payload.text.trim()) throw invalid(`has an empty ${where} answer text.`);
  if (payload.chunks !== undefined) {
    if (!Array.isArray(payload.chunks) || payload.chunks.some((chunk) => typeof chunk !== "string")) {
      throw invalid(`has malformed ${where} chunks.`);
    }
    // The answer is the full `text`; chunks are the identical streamed
    // fragments. Use one representation only, never both.
    if (payload.chunks.join("") !== payload.text) throw invalid(`has ${where} chunks that do not match its answer text.`);
  }
  return payload.text;
}

function stepAnswerText(entry) {
  const blocks = Array.isArray(entry?.blocks) ? entry.blocks : null;
  if (!blocks) throw invalid("entry is missing its content blocks.");
  for (const block of blocks) {
    if (!["plan", "workflow_root", "answer_tabs", "pending_followups"].includes(block?.intended_usage)) throw invalid("has an unsupported content block.");
    if (block.intended_usage === "answer_tabs") {
      const tabs = block.answer_tabs_block;
      if (!Array.isArray(tabs?.modes) || !Array.isArray(tabs.reformulated_queries) || tabs.reformulated_queries.length || tabs.modes.some((mode) => !["ANSWER", "IMAGE"].includes(mode.answer_mode_type) || mode.has_preview === true)) throw invalid("has unsupported answer tab content.");
    }
    if (block.intended_usage === "pending_followups" && (!Array.isArray(block.pending_followups_block?.followups) || block.pending_followups_block.followups.length)) throw invalid("has unsupported follow-up content.");
  }
  const roots = blocks.filter((block) => block?.intended_usage === WORKFLOW_BLOCK);
  if (roots.length !== 1) throw invalid(`entry has ${roots.length} ${WORKFLOW_BLOCK} blocks; only one answer workflow is supported.`);
  const workflow = roots[0].workflow_block;
  if (!workflow || typeof workflow !== "object") throw invalid("entry is missing its workflow block.");
  if (workflow.status !== "WORKFLOW_COMPLETED") throw invalid(`workflow is in state "${String(workflow.status)}"; wait for it to finish and retry.`);
  if (!Array.isArray(workflow.snapshots) || workflow.snapshots.length) throw invalid("has unverified workflow snapshots.");
  if (!Array.isArray(workflow.steps) || workflow.steps.length !== 1) throw invalid("entry does not have one unambiguous completed answer step.");
  return workflow.steps.map((step, stepIndex) => {
    if (step?.status !== "WORKFLOW_COMPLETED") throw invalid(`step ${stepIndex} is in state "${String(step?.status)}"; wait for it to finish and retry.`);
    if (!Array.isArray(step.items) || step.items.length !== 1) throw invalid(`step ${stepIndex} has unsupported step items.`);
    return step.items.map((item, itemIndex) => {
      const where = `step ${stepIndex} item ${itemIndex}`;
      if (item?.type !== WORKFLOW_ITEM_TEXT) throw invalid(`has an unsupported ${where} type "${String(item?.type)}"; visible content could be lost.`);
      if (item.variant !== ANSWER_VARIANT) throw invalid(`has an unsupported ${where} variant "${String(item?.variant)}".`);
      return requireAnswerText(item.payload?.text_payload, where);
    }).filter(Boolean).join("\n\n");
  }).filter(Boolean).join("\n\n");
}

function entryText(entry, index) {
  const query = typeof entry?.query_str === "string" ? entry.query_str : "";
  if (!query.trim()) throw invalid(`entry ${index} has no user query text.`);
  if (entry.status !== "COMPLETED") throw invalid(`entry ${index} is in state "${String(entry.status)}"; wait for it to finish and retry.`);
  return { id: entry.frontend_uuid || entry.uuid || "", user: query, assistant: stepAnswerText(entry) };
}

export function parsePerplexityConversation(data, fallbackConversationId = "") {
  if (!data || typeof data !== "object") throw invalid("returned an empty response.");
  if (data.status !== "success") throw invalid(`reported status "${String(data.status)}".`);
  if (data.has_next_page !== false || (data.next_cursor !== null && data.next_cursor !== undefined)) {
    throw invalid("returned a paginated conversation; messages outside this page could be lost.");
  }
  if (data.latest_entry !== null && data.latest_entry !== undefined) throw invalid("reports a newer entry than the returned page.");
  if (!Array.isArray(data.entries) || !data.entries.length) throw invalid("returned no conversation entries.");
  if (!Array.isArray(data.background_entries) || data.background_entries.length) {
    throw invalid("returned background entries that are not part of the main conversation.");
  }
  const parentInfo = data.thread_metadata?.parent_info;
  if (parentInfo !== null) throw invalid("returned missing or fork parent metadata; only the current conversation is supported.");
  if (data.thread_metadata.workflow_snapshots !== null) throw invalid("returned unverified conversation snapshots.");
  if (!data.first_entry) throw invalid("did not identify the first conversation entry.");
  if (fallbackConversationId && data.first_entry.backend_uuid !== fallbackConversationId) throw invalid("returned a different conversation than the open session.");
  const firstUuid = data.first_entry.uuid || data.first_entry.frontend_uuid || "";
  const entriesFirstUuid = data.entries[0]?.uuid || data.entries[0]?.frontend_uuid || "";
  if (!firstUuid || firstUuid !== entriesFirstUuid) throw invalid("first entry does not match the first returned entry.");
  const contextId = data.first_entry.context_uuid;
  const ids = data.entries.map((entry) => entry?.uuid);
  if (!contextId || data.entries.some((entry) => entry?.context_uuid !== contextId) || ids.some((id) => !id) || new Set(ids).size !== ids.length) throw invalid("returned ambiguous or duplicated conversation entries.");

  const messages = [];
  data.entries.forEach((entry, index) => {
    const { id, user, assistant } = entryText(entry, index);
    const userText = cleanText(user);
    const assistantText = cleanText(assistant);
    if (!userText) throw invalid(`entry ${index} has an empty user query.`);
    if (!assistantText) throw invalid(`entry ${index} has an empty answer.`);
    messages.push({ id: id ? `${id}:user` : "", role: "user", text: userText });
    messages.push({ id: id ? `${id}:assistant` : "", role: "assistant", text: assistantText });
  });
  return {
    platform: "perplexity",
    id: data.first_entry?.context_uuid || fallbackConversationId,
    title: data.thread_metadata?.title || "",
    messages
  };
}

export const perplexityAdapter = {
  id: "perplexity",
  matches(url) { return Boolean(conversationId(url)); },
  async extractConversation({ url, fetch }) {
    const id = conversationId(url);
    if (!id) throw new CopyError(ErrorCode.MISSING_CONVERSATION_ID, "Open a saved Perplexity conversation first.");
    const endpoint = `https://www.perplexity.ai/rest/thread/${encodeURIComponent(id)}?${THREAD_QUERY}`;
    // Same-origin cookies are the only credential; no token is read or stored.
    const response = await fetch(endpoint, { credentials: "include", headers: { accept: "application/json" } });
    if (!response.ok) throw responseError(response.status, "Perplexity");
    return parsePerplexityConversation(await response.json(), id);
  }
};
