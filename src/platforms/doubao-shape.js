// Structural fingerprint of a Doubao history response, for diagnosing a failed
// parse without exposing any conversation content. Reports only shapes, counts,
// checksums-free type information and key names -- never message text, ids,
// cookies, or tokens.

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const typeOf = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  return typeof value;
};
const keysOf = (value) => (isObject(value) ? Object.keys(value).sort() : []);
const unionKeys = (items) => {
  const keys = new Set();
  for (const item of items) for (const key of keysOf(item)) keys.add(key);
  return [...keys].sort();
};
const valueTypeSummary = (items, key) => {
  const types = new Set();
  for (const item of items) types.add(typeOf(item?.[key]));
  return [...types].sort().join("|");
};

/**
 * @param {unknown} data raw response body
 * @param {string} conversationId expected conversation id (never echoed back)
 */
export function summarizeDoubaoResponse(data, conversationId) {
  const body = data?.downlink_body?.pull_singe_chain_downlink_body;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const sections = new Set(), userTypes = new Set(), blockCounts = new Set();
  const blockTypes = new Set(), contentKeys = new Set(), textKeys = new Set();
  const indexValues = [];
  let regenNonEmpty = 0, unfinished = 0, idMismatch = 0;
  const contentKeyUnion = new Set(), textKeyUnion = new Set();

  for (const message of messages) {
    if (message?.conversation_id !== conversationId) idMismatch++;
    if (typeof message?.section_id === "string") sections.add(message.section_id);
    userTypes.add(typeOf(message?.user_type) + ":" + String(message?.user_type));
    if (Array.isArray(message?.regen_msg_list) && message.regen_msg_list.length) regenNonEmpty++;
    if (message?.status !== 0 || message?.content_status !== 0 || message?.ext?.is_finish !== "1") unfinished++;
    if (typeof message?.index_in_conv === "string" && /^\d+$/.test(message.index_in_conv)) indexValues.push(Number(message.index_in_conv));
    const blocks = Array.isArray(message?.content_block) ? message.content_block : [];
    blockCounts.add(blocks.length);
    for (const block of blocks) {
      blockTypes.add(String(block?.block_type) + ":" + typeOf(block?.is_finish));
      for (const key of keysOf(block?.content)) contentKeyUnion.add(key);
      const textBlock = block?.content?.text_block;
      for (const key of keysOf(textBlock)) textKeyUnion.add(key);
      if (!isObject(textBlock)) continue;
      // Record only which text fields are non-empty, not their contents.
      for (const key of keysOf(textBlock)) {
        if (typeof textBlock[key] === "string" && textBlock[key].length) textKeys.add(key);
      }
      for (const key of keysOf(block?.content)) contentKeys.add(key);
    }
  }

  const sorted = [...indexValues].sort((a, b) => a - b);
  return {
    cmd: data?.cmd ?? null,
    status_code: data?.status_code ?? null,
    has_body: isObject(body),
    body_keys: keysOf(body),
    has_more: body?.has_more ?? null,
    msg_cursor_type: typeOf(body?.msg_cursor),
    regen_messages_type: typeOf(body?.regen_messages),
    regen_messages_nonempty: isObject(body?.regen_messages) ? Object.keys(body.regen_messages).length > 0 : null,
    message_count: messages.length,
    message_count_is_odd: messages.length % 2 === 1,
    message_keys: unionKeys(messages),
    user_type_values: [...userTypes].sort(),
    user_type_field_types: unionKeys(messages).includes("user_type") ? valueTypeSummary(messages, "user_type") : null,
    index_min: sorted[0] ?? null,
    index_max: sorted.at(-1) ?? null,
    index_count: indexValues.length,
    index_distinct: new Set(indexValues).size,
    first_index_is_one: sorted[0] === 1,
    section_count: sections.size,
    regen_msg_list_nonempty_count: regenNonEmpty,
    unfinished_message_count: unfinished,
    conversation_id_mismatch_count: idMismatch,
    content_block_counts: [...blockCounts].sort((a, b) => a - b),
    block_type_variants: [...blockTypes].sort(),
    content_keys: [...contentKeyUnion].sort(),
    text_block_keys: [...textKeyUnion].sort(),
    nonempty_text_fields: [...textKeys].sort()
  };
}
