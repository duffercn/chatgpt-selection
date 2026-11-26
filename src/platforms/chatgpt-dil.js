// Static conversion of ChatGPT "DIL" rich content (messages flagged with
// metadata.model_dil_v2) into readable Markdown.
//
// The markup mixes Markdown with JSX/Svelte-like components and inline JS.
// Nothing here executes that code: literals are parsed by a small JSON-like
// reader and only plain paths (`q.opts`, `i+1`) are resolved. Lines outside
// recognised component blocks are copied byte-for-byte, so ordinary Markdown,
// tables and LaTeX are never touched.

const KNOWN_TAGS = new Set([
  // layout
  "box", "row", "col", "grid", "grid-item", "card", "spacer", "list", "list-item",
  // text
  "text", "title", "caption", "label", "badge", "divider", "icon", "Link", "Cite", "FileCite",
  "Entity", "WritingBlock", "CodeBlock",
  // tables and charts
  "table", "table-row", "table-cell", "Chart",
  // media
  "AsyncImage", "AsyncImageGroup", "svg", "math",
  // interactive
  "button", "input", "segmented-control", "radio-group", "radio", "checkbox", "slider",
  "form", "pressable", "LearningQuiz"
]);
const INLINE_TAGS = new Set(["text", "title", "caption", "label", "badge", "radio", "Link", "Entity"]);
// Blocks that read naturally inside a sentence and are converted inline there.
const SVG_DROP = new Set(["path", "rect", "circle", "line", "g", "defs", "polygon", "polyline", "ellipse"]);
const UNRESOLVED = Symbol("unresolved");
const WIDGET_NOTE = "[Interactive widget: not copied]";
const UNSUPPORTED_NOTE = "[Unsupported interactive content]";
const FAILED_NOTE = "[Rich content could not be converted]";

class DilError extends Error {}

// ---------- tokenizer ----------

function skipString(src, i) {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j += 1) {
    if (src[j] === "\\") { j += 1; continue; }
    if (src[j] === quote) return j + 1;
  }
  throw new DilError("unterminated string");
}

// Returns the index just past the `}` matching the `{` at `start`.
// Braces nest, so object literals inside expressions are counted too.
function braceEnd(src, start) {
  let depth = 0;
  for (let i = start; i < src.length;) {
    const ch = src[i];
    if (ch === "\"" || ch === "'" || ch === "`") { i = skipString(src, i); continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return i + 1;
    i += 1;
  }
  throw new DilError("unbalanced braces");
}
function readTag(src, start) {
  const name = /^<([A-Za-z][\w-]*)/.exec(src.slice(start, start + 64))?.[1];
  if (!name) throw new DilError("bad tag");
  const attrs = {};
  let i = start + 1 + name.length;
  while (i < src.length) {
    while (/\s/.test(src[i])) i += 1;
    if (src.startsWith("/>", i)) return { name, attrs, selfClosing: true, end: i + 2 };
    if (src[i] === ">") return { name, attrs, selfClosing: false, end: i + 1 };
    const key = /^[A-Za-z_:][\w:.-]*/.exec(src.slice(i, i + 64))?.[0];
    if (!key) throw new DilError(`bad attribute in <${name}>`);
    i += key.length;
    if (src[i] !== "=") { attrs[key] = { flag: true }; continue; }
    i += 1;
    if (src[i] === "\"" || src[i] === "'") {
      const end = skipString(src, i);
      attrs[key] = { string: src.slice(i + 1, end - 1) };
      i = end;
    } else if (src[i] === "{") {
      const end = braceEnd(src, i);
      attrs[key] = { expr: src.slice(i + 1, end - 1).trim() };
      i = end;
    } else {
      const word = /^[^\s>/]+/.exec(src.slice(i))?.[0];
      if (!word) throw new DilError(`bad attribute value in <${name}>`);
      attrs[key] = { string: word };
      i += word.length;
    }
  }
  throw new DilError(`unterminated <${name}>`);
}

// Next token at `i`. Every token has end > i, so callers always advance.
function nextToken(src, i) {
  if (src.startsWith("\\(", i) || src.startsWith("\\[", i)) {
    const closer = src[i + 1] === "(" ? "\\)" : "\\]";
    const close = src.indexOf(closer, i + 2);
    const end = close < 0 ? src.length : close + 2;
    return { type: "text", value: src.slice(i, end), end };
  }
  if (src.startsWith("</", i)) {
    const match = /^<\/([A-Za-z][\w-]*)\s*>/.exec(src.slice(i, i + 64));
    if (!match) throw new DilError("bad closing tag");
    return { type: "close", name: match[1], end: i + match[0].length };
  }
  if (src[i] === "<" && /[A-Za-z]/.test(src[i + 1] || "")) return { type: "open", ...readTag(src, i) };
  if (src[i] === "{") {
    const end = braceEnd(src, i);
    const body = src.slice(i + 1, end - 1).trim();
    if (body.startsWith("@")) return { type: "body", src: body.replace(/^@\s*body\s*/, ""), end };
    if (body.startsWith("#")) return { type: "control", kind: /^#(\w+)/.exec(body)?.[1], head: body, end };
    if (body.startsWith("/")) return { type: "endcontrol", kind: body.slice(1).trim(), end };
    if (body.startsWith(":")) return { type: "else", end };
    return { type: "expr", src: body, end };
  }
  let end = i + 1;
  while (end < src.length) {
    const ch = src[end];
    if (ch === "{" || (ch === "\\" && /[([]/.test(src[end + 1] || ""))) break;
    if (ch === "<" && /[A-Za-z/]/.test(src[end + 1] || "")) break;
    end += 1;
  }
  return { type: "text", value: src.slice(i, end), end };
}

// Parses one component block starting at `start`; returns its nodes and end offset.
function parseBlock(src, start) {
  const root = { type: "root", children: [] };
  const stack = [root];
  let i = start;
  while (i < src.length) {
    const token = nextToken(src, i);
    const top = stack[stack.length - 1];
    if (stack.length === 1 && token.type === "text") {
      if (token.value.trim()) break;
      i = token.end;
      continue;
    }
    if (token.type === "open") {
      const node = { type: "tag", name: token.name, attrs: token.attrs, children: [] };
      top.children.push(node);
      if (!token.selfClosing) stack.push(node);
    } else if (token.type === "close") {
      if (top.type === "tag" && top.name === token.name) stack.pop();
      else if (top.type === "tag" && !KNOWN_TAGS.has(token.name)) top.children.push({ type: "text", value: src.slice(i, token.end) });
      else throw new DilError(`mismatched </${token.name}>`);
    } else if (token.type === "control") {
      const node = { type: token.kind, head: token.head, children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (token.type === "endcontrol") {
      if (top.type !== token.kind) throw new DilError(`mismatched {/${token.kind}}`);
      stack.pop();
    } else if (token.type === "else") {
      if (top.type !== "if") throw new DilError("{:else} outside {#if}");
    } else if (token.type === "body") {
      top.children.push({ type: "body", src: token.src });
    } else {
      // Inline LaTeX arrives as its own text token; merge so Markdown lines stay whole.
      const last = top.children[top.children.length - 1];
      if (token.type === "text" && last?.type === "text") last.value += token.value;
      else top.children.push({ ...token });
    }
    i = token.end;
  }
  if (stack.length !== 1) throw new DilError("unclosed component block");
  return { nodes: root.children, end: i };
}

// ---------- safe literal reader (JSON plus bare keys / single quotes / trailing commas) ----------

export function parseLiteral(source) {
  const src = source.trim();
  let i = 0;
  const ws = () => { while (/\s/.test(src[i] || "")) i += 1; };
  const value = () => {
    ws();
    const ch = src[i];
    if (ch === "[") {
      i += 1;
      const out = [];
      for (ws(); src[i] !== "]"; ws()) {
        out.push(value());
        ws();
        if (src[i] === ",") i += 1;
        else if (src[i] !== "]") throw new DilError("bad array");
      }
      i += 1;
      return out;
    }
    if (ch === "{") {
      i += 1;
      const out = {};
      for (ws(); src[i] !== "}"; ws()) {
        let key;
        if (src[i] === "\"" || src[i] === "'") key = value();
        else {
          key = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))?.[0];
          if (!key) throw new DilError("bad key");
          i += key.length;
        }
        ws();
        if (src[i] !== ":") throw new DilError("bad object");
        i += 1;
        out[key] = value();
        ws();
        if (src[i] === ",") i += 1;
        else if (src[i] !== "}") throw new DilError("bad object");
      }
      i += 1;
      return out;
    }
    if (ch === "\"" || ch === "'") {
      const end = skipString(src, i);
      const body = src.slice(i + 1, end - 1);
      i = end;
      return ch === "\"" ? JSON.parse(`"${body}"`) : JSON.parse(`"${body.replace(/\\'/g, "'").replace(/"/g, "\\\"")}"`);
    }
    const word = /^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null)/i.exec(src.slice(i))?.[0];
    if (!word) throw new DilError("not a literal");
    i += word.length;
    return JSON.parse(word.toLowerCase());
  };
  const result = value();
  ws();
  if (i !== src.length) throw new DilError("trailing input");
  return result;
}

// ---------- expression resolution (paths only, never execution) ----------

function lookup(path, scope) {
  const parts = path.match(/[A-Za-z_$][\w$]*|\d+/g);
  let current = scope;
  for (const part of parts) {
    if (current == null || !(part in Object(current))) return UNRESOLVED;
    current = current[part];
  }
  return current;
}

function resolve(expr, scope) {
  const src = expr.trim();
  const raw = /^String\.raw`([\s\S]*)`$/.exec(src);
  if (raw) return raw[1];
  if (/^`[^`$]*`$/.test(src)) return src.slice(1, -1);
  try { return parseLiteral(src); } catch { /* not a literal */ }
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/.test(src)) return lookup(src, scope);
  const plus = /^([A-Za-z_$][\w$]*)\s*\+\s*(\d+)$/.exec(src);
  if (plus) {
    const base = lookup(plus[1], scope);
    return typeof base === "number" ? base + Number(plus[2]) : UNRESOLVED;
  }
  return UNRESOLVED;
}

function attrValue(attr, scope) {
  if (!attr) return undefined;
  if ("string" in attr) return attr.string;
  if ("expr" in attr) return resolve(attr.expr, scope);
  return true;
}

// ---------- rendering ----------

function dedent(text) {
  return text.split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Inline text of a tag; null when it depends on runtime state.
function inlineText(children, scope) {
  let out = "";
  for (const child of children) {
    if (child.type === "text") out += child.value;
    else if (child.type === "expr") {
      const value = resolve(child.src, scope);
      if (value === UNRESOLVED || (value !== null && typeof value === "object")) return null;
      out += value ?? "";
    } else if (child.type === "tag" && INLINE_TAGS.has(child.name)) {
      const inner = inlineText(child.children, scope);
      if (inner === null) return null;
      out += inner;
    } else if (child.type === "if" || child.type === "body") continue;
    else if (child.type === "tag" && child.name === "icon") continue;
    else return null;
  }
  return out.replace(/\s+/g, " ").trim();
}

function svgLabels(children, labels = []) {
  for (const child of children) {
    if (child.type !== "tag") continue;
    if (child.name === "text") {
      const text = child.children.filter((c) => c.type === "text").map((c) => c.value).join("").trim();
      if (text) labels.push(text);
    } else svgLabels(child.children, labels);
  }
  return labels;
}

// A sole URL literal (`["https://…"]`) is unwrapped; other citations are dropped.
function citeLink(attrs, scope) {
  const refs = attrValue(attrs.refs, scope);
  const list = Array.isArray(refs) ? refs : refs === undefined ? [] : [refs];
  const urls = list.filter((ref) => typeof ref === "string" && /^https?:\/\//.test(ref));
  if (urls.length === 0 || urls.length !== list.length) return "";
  return urls.join(" ");
}

function cellText(node, scope) {
  const parts = renderNode(node, scope).join(" ").replace(/\|/g, "\\|");
  return parts.replace(/\s+/g, " ").trim() || " ";
}

function rowCells(children, scope) {
  return children
    .filter((c) => c.type === "tag" && c.name === "table-cell")
    .map((c) => cellText(c, scope));
}

// Accepts either a `<table>` wrapper, `<table-row>` nodes, or bare `<table-cell>` nodes.
// Renders rows/cells (and a `<table>` wrapper's children) as one Markdown table.
function renderTable(nodes, scope) {
  const rows = [];
  const loose = [];
  const flat = nodes.flatMap((node) => (node.type === "tag" && node.name === "table" ? node.children : [node]));
  for (const node of flat) {
    if (node.type === "tag" && node.name === "table-row" && node.children.some((c) => c.type === "tag" && c.name === "table-cell")) {
      rows.push(rowCells(node.children, scope));
    } else if (node.type === "tag" && node.name === "table-cell") {
      rows.push([cellText(node, scope)]);
    } else if (node.type === "tag" && node.name === "table") {
      // Handled by the caller, which flattens the wrapper first.
      continue;
    } else {
      loose.push(...renderNode(node, scope));
    }
  }
  const table = rows.filter((cells) => cells.length > 0);
  if (table.length < 2) return loose.concat(table.map((cells) => cells.join(" "))).filter(Boolean);
  const width = Math.max(...table.map((cells) => cells.length));
  const lines = table.map((cells) => `| ${[...cells, ...Array(width - cells.length).fill(" ")].join(" | ")} |`);
  lines.splice(1, 0, `|${Array(width).fill("---").join("|")}|`);
  return loose.concat(lines);
}

function renderChart(attrs, scope) {
  const content = attrValue(attrs.content, scope);
  const chart = content && typeof content === "object" ? content : null;
  const label = (value) => (typeof value === "string" ? value : value?.label ?? value?.name ?? "");
  const title = label(chart?.meta?.title) || label(attrs.title) || label(chart?.chartType) || "Chart";
  const blocks = [`[Chart: ${title}]`];
  const rows = Array.isArray(chart?.data) ? chart.data : [];
  const xKey = typeof chart?.xKey === "string" ? chart.xKey : null;
  const series = Array.isArray(chart?.series) ? chart.series.filter((s) => typeof s?.dataKey === "string") : [];
  if (rows.length && xKey && series.length && rows.every((row) => row && typeof row === "object")) {
    const cell = (value) => (value === undefined || value === null ? "" : String(value).replace(/\|/g, "\\|"));
    const lines = [`| ${[xKey, ...series.map((s) => label(s) || s.dataKey)].join(" | ")} |`, `|${Array(series.length + 1).fill("---").join("|")}|`];
    for (const row of rows) lines.push(`| ${[cell(row[xKey]), ...series.map((s) => cell(row[s.dataKey]))].join(" | ")} |`);
    blocks.push(lines.join("\n"));
  }
  const note = label(chart?.meta?.description);
  if (note) blocks.push(note);
  return blocks;
}

function renderQuiz(attrs, scope) {
  const title = attrValue(attrs.title, scope);
  const questions = attrValue(attrs.questions, scope);
  if (!Array.isArray(questions)) return [UNSUPPORTED_NOTE];
  const blocks = [];
  if (typeof title === "string" && title) blocks.push(`**${title}**`);
  questions.forEach((question, index) => {
    const lines = [`${index + 1}. ${question?.question ?? ""}`.trim()];
    for (const option of question?.options || []) lines.push(`- ${option?.label ?? option?.value ?? ""}`);
    if (question?.hint) lines.push(`Hint: ${question.hint}`);
    blocks.push(lines.join("\n"));
  });
  return blocks;
}

function renderEach(node, scope) {
  const head = /^#each\s+([\s\S]+?)\s+as\s+([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*))?\s*$/.exec(node.head);
  const list = head ? resolve(head[1], scope) : UNRESOLVED;
  if (!Array.isArray(list)) {
    // The list lives in runtime state. Render the template once without data (one
    // line per distinct text) so labels survive and per-item answer feedback does not.
    const probe = Object.create(scope);
    return dedupe(renderChildren(node.children, probe));
  }
  return list.flatMap((item, index) => {
    const inner = Object.create(scope);
    inner[head[2]] = item;
    if (head[3]) inner[head[3]] = index;
    return renderChildren(node.children, inner);
  });
}

// A template rendered once without its data repeats the same lines; keep one of each.
function dedupe(blocks) {
  return blocks.filter((block, index) => blocks.indexOf(block) === index);
}

const TABLE_PARTS = new Set(["table", "table-row", "table-cell"]);

function isTablePart(node) {
  return node.type === "tag" && TABLE_PARTS.has(node.name);
}

function renderChildren(children, scope) {
  const blocks = [];
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    // Sibling rows and cells belong to one table; hand them over together.
    if (child.type === "tag" && (child.name === "table-row" || child.name === "table-cell")) {
      const run = [child];
      while (i + 1 < children.length && isTablePart(children[i + 1])) run.push(children[(i += 1)]);
      blocks.push(...renderTable(run, scope));
      continue;
    }
    blocks.push(...renderNode(child, scope));
  }
  return blocks;
}

function renderNode(node, scope) {
  if (node.type === "text") {
    const text = dedent(node.value);
    return text ? [text] : [];
  }
  if (node.type === "expr") {
    const value = resolve(node.src, scope);
    return typeof value === "string" || typeof value === "number" ? [String(value)] : [];
  }
  if (node.type === "body") return [];
  // Conditional branches depend on what the viewer clicked; nothing is shown as answered.
  if (node.type === "if") return [];
  if (node.type === "each") return renderEach(node, scope);
  if (node.type !== "tag") {
    scope.unsupported = true;
    return [];
  }
  const { name, attrs, children } = node;
  switch (name) {
    // Layout containers only group their children.
    case "box":
    case "col":
    case "grid":
    case "grid-item":
    case "card":
      return renderChildren(children, scope);
    case "row": {
      const blocks = renderChildren(children, scope);
      return blocks.length > 1 && blocks.every((b) => !b.includes("\n")) ? [blocks.join(" ")] : blocks;
    }
    case "divider":
    case "icon":
    case "spacer":
      return [];
    case "text":
    case "caption":
    case "label":
    case "badge": {
      const text = inlineText(children, scope);
      return text ? [text] : [];
    }
    case "title": {
      const text = inlineText(children, scope);
      return text ? [`**${text}**`] : [];
    }
    case "radio": {
      const text = inlineText(children, scope);
      return text ? [`- ${text}`] : [];
    }
    case "radio-group":
      return [renderChildren(children, scope).join("\n")].filter(Boolean);
    case "list": {
      const numbered = String(attrValue(attrs.marker, scope) || "") === "number";
      return renderChildren(children, scope).map((item, index) => {
        const marker = numbered ? `${index + 1}.` : "-";
        return item.split("\n").map((line, i) => (i === 0 ? `${marker} ${line}` : `  ${line}`)).join("\n");
      });
    }
    case "list-item":
      return [renderChildren(children, scope).join("\n\n")].filter(Boolean);
    // Sibling rows/cells are collected together, so a fragment still renders as a table.
    // A cell renders its own content; only a bare fragment row/cell starts a table.
    case "table":
      // A table may hold loose text around its rows.
      return renderTable(children, scope);
    case "table-row":
      // Rows are collected by the enclosing table; a bare row renders on its own.
      return renderTable([node], scope);
    case "table-cell":
      return renderChildren(children, scope);
    case "Link": {
      const label = inlineText(children, scope);
      const url = attrValue(attrs.url, scope) ?? attrValue(attrs.href, scope);
      const title = attrValue(attrs.title, scope);
      const text = label || (typeof title === "string" ? title : "");
      if (typeof url === "string" && url) return [text ? `[${text}](${url})` : `<${url}>`];
      return text ? [text] : [];
    }
    case "Cite":
    case "FileCite":
      // Citations point at search/file results that are not in this payload. A bare
      // URL reference is the one case with something readable to show.
      return [citeLink(attrs, scope)].filter(Boolean);
    case "Entity": {
      const value = attrValue(attrs.value, scope) ?? attrValue(attrs.name, scope);
      if (typeof value === "string" && value) return [value];
      const text = inlineText(children, scope);
      return text ? [text] : [];
    }
    case "WritingBlock": {
      const text = renderChildren(children, scope).join("\n\n").trim();
      if (text) return [text];
      const content = attrValue(attrs.content, scope);
      return typeof content === "string" && content.trim() ? [content.trim()] : [];
    }
    case "CodeBlock": {
      const text = children.map((child) => (child.type === "text" ? child.value : "")).join("");
      const code = text.trim() || (() => {
        const content = attrValue(attrs.content, scope) ?? attrValue(attrs.code, scope);
        return typeof content === "string" ? content.trim() : "";
      })();
      if (!code) return [];
      const language = attrValue(attrs.language, scope);
      const fence = code.includes("```") ? "````" : "```";
      return [`${fence}${typeof language === "string" ? language : ""}\n${code}\n${fence}`];
    }
    case "Chart":
      return renderChart(attrs, scope);
    case "AsyncImageGroup": {
      const query = attrValue(attrs.query, scope);
      const list = Array.isArray(query) ? query : typeof query === "string" ? [query] : [];
      const images = list.filter((q) => typeof q === "string" && q).map((q) => `[Image: ${q}]`);
      return images.length ? [images.join("\n\n")] : ["[Image]"];
    }
    case "slider": {
      scope.widget = true;
      const marks = attrValue(attrs.marks, scope);
      const labels = Array.isArray(marks) ? marks.map((m) => m?.label).filter((l) => l !== undefined && l !== null && l !== "") : [];
      return labels.length ? [`Options: ${labels.join(" / ")}`] : [];
    }
    case "checkbox": {
      scope.widget = true;
      const text = inlineText(children, scope);
      return text ? [text] : [];
    }
    // A form only submits and a pressable only opens details: both keep their text.
    case "form":
      return renderChildren(children, scope);
    case "pressable":
      return renderChildren(children, scope);
    case "math": {
      const value = attrValue(attrs.value, scope);
      if (typeof value !== "string") { scope.unsupported = true; return []; }
      return [attrs.block ? `\\[\n${value.trim()}\n\\]` : `\\(${value.trim()}\\)`];
    }
    case "AsyncImage": {
      const query = attrValue(attrs.query, scope);
      return [typeof query === "string" && query ? `[Image: ${query}]` : "[Image]"];
    }
    case "svg": {
      const labels = svgLabels(children);
      return [labels.length ? `[Diagram: ${labels.join(" · ")}]` : "[Diagram]"];
    }
    case "LearningQuiz":
      return renderQuiz(attrs, scope);
    case "segmented-control": {
      scope.widget = true;
      const options = attrValue(attrs.options, scope);
      const labels = Array.isArray(options) ? options.map((o) => o?.label).filter((l) => typeof l === "string") : [];
      return labels.length ? [`Options: ${labels.join(" / ")}`] : [];
    }
    // Controls have no static text; the block still says it was interactive.
    case "input":
    case "button":
      scope.widget = true;
      return [];
    default:
      if (SVG_DROP.has(name)) return [];
      scope.unsupported = true;
      return renderChildren(children, scope);
  }
}

// `reuse` lets several sibling fragments share one context, so notes appear once.
// `outer` collects flags for the surrounding text without emitting notes here.
function childrenOf(node) {
  return node.type === "tag" ? node.children : [];
}

function renderBlock(nodes) {
  const root = Object.create(null);
  for (const node of nodes) {
    if (node.type !== "body") continue;
    const decl = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*)$/.exec(node.src);
    if (!decl) continue;
    try { root[decl[1]] = parseLiteral(decl[2]); } catch { /* runtime logic, not data */ }
  }
  let out = "";
  const push = (text, glue = "\n\n") => {
    if (!text) return;
    out = out ? `${out}${glue}${text}` : text;
  };
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    // Each top-level component keeps its own flags, so a widget's note follows it.
    const scope = Object.create(root);
    // Neighbouring rows/cells form one table; its lines stay on consecutive lines.
    if (node.type === "tag" && (node.name === "table-row" || node.name === "table-cell")) {
      const run = [node];
      while (i + 1 < nodes.length && isTablePart(nodes[i + 1])) run.push(nodes[(i += 1)]);
      push(renderTable(run, scope).join("\n"));
      continue;
    }
    if (node.type === "tag" && node.name === "table") {
      push(renderTable(childrenOf(node), scope).join("\n"));
      continue;
    }
    push(renderNode(node, scope).join("\n\n"));
    if (scope.widget) push(WIDGET_NOTE);
    if (scope.unsupported) push(UNSUPPORTED_NOTE);
  }
  return out;
}

// ---------- entry ----------

// Collects neighbouring `<table…>` fragments so the renderer sees whole rows. A
// `<table>` wrapper is read to its closing tag; bare rows/cells run until a blank
// line or a fragment that overran its own line.
function tableRun(text, start) {
  let end = start;
  let nodes = [];
  while (end < text.length) {
    if (nodes.length && text[end - 1] === "\n" && text[end] === "\n") break;
    const lineEnd = text.indexOf("\n", end);
    const line = text.slice(end, lineEnd < 0 ? text.length : lineEnd);
    if (!isTableLine(line)) break;
    let fragment;
    try {
      fragment = parseBlock(text, end);
    } catch {
      break;
    }
    nodes = nodes.concat(fragment.nodes);
    end = fragment.end > end ? fragment.end : (lineEnd < 0 ? text.length : lineEnd + 1);
    // A `<table>` block owns all of its rows; bare rows end when a fragment overruns.
    const wrapped = nodes.some((node) => node.type === "tag" && node.name === "table");
    if (wrapped) break;
    if (lineEnd >= 0 && (fragment.end > lineEnd || !endsBalanced(text.slice(start, fragment.end)))) break;
  }
  return nodes.length ? { nodes, end } : null;
}

// True when every tag opened inside `src` was closed again.
function endsBalanced(src) {
  const open = (src.match(/<[A-Za-z][\w-]*(?:"[^"]*"|'[^']*'|[^>"'])*[^/>]>/g) || []).length;
  const close = (src.match(/<\/[A-Za-z][\w-]*>/g) || []).length;
  const controls = (src.match(/\{#[\w]+/g) || []).length - (src.match(/\{\/[\w]+\}/g) || []).length;
  return open === close && controls === 0;
}

function startsBlock(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("{@") || trimmed.startsWith("{#")) return true;
  const tag = /^<([A-Za-z][\w-]*)/.exec(trimmed)?.[1];
  return Boolean(tag && KNOWN_TAGS.has(tag));
}

export function convertDilMarkup(input) {
  return convertBlocks(input, startsBlock);
}

// `<table>`/`<table-row>`/`<table-cell>` fragments are converted as one run so the
// table renderer sees whole rows instead of one fragment per line.
const TABLE_TAGS = new Set(["table", "table-row", "table-cell"]);

function isTableLine(line) {
  const tag = /^<\/?([A-Za-z][\w-]*)/.exec(line.trimStart())?.[1];
  return Boolean(tag && TABLE_TAGS.has(tag));
}

// Components that read naturally inside a sentence.
const INLINE_BLOCK_TAGS = new Set(["Link", "Cite", "FileCite", "Entity", "AsyncImage"]);

function convertInline(line) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "<") { out += line[i]; i += 1; continue; }
    const name = /^<([A-Za-z][\w-]*)/.exec(line.slice(i, i + 64))?.[1];
    if (!name || !INLINE_BLOCK_TAGS.has(name)) { out += line[i]; i += 1; continue; }
    let block;
    try {
      block = parseBlock(line, i);
    } catch {
      out += line[i];
      i += 1;
      continue;
    }
    out += renderBlock(block.nodes);
    i = block.end > i ? block.end : i + 1;
  }
  return out;
}

function convertBlocks(input, isBlockStart) {
  const text = String(input ?? "");
  let out = "";
  let pos = 0;
  let inFence = false;
  while (pos < text.length) {
    const lineEnd = text.indexOf("\n", pos);
    const next = lineEnd < 0 ? text.length : lineEnd + 1;
    const line = text.slice(pos, lineEnd < 0 ? text.length : lineEnd);
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && isTableLine(line)) {
      const run = tableRun(text, pos);
      if (run) {
        out += `${renderBlock(run.nodes)}\n\n`;
        pos = run.end > pos ? run.end : next;
        continue;
      }
    }
    if (inFence || !isBlockStart(line)) {
      // Inline components (e.g. a `<Link …/>` inside a sentence) still need conversion.
      out += inFence ? text.slice(pos, next) : convertInline(text.slice(pos, next));
      pos = next;
      continue;
    }
    let block;
    try {
      block = parseBlock(text, pos);
    } catch {
      // Unparseable: keep the rest verbatim but say so, rather than dropping content.
      return `${out}${FAILED_NOTE}\n\n${text.slice(pos)}`;
    }
    const rendered = renderBlock(block.nodes);
    // Padded only when the block stands on its own line; inside a sentence it flows.
    const startsLine = pos === 0 || text[pos - 1] === "\n";
    // A block ends its line when only a line break (or end of text) follows.
    const alone = startsLine && /^[ \t]*(\n|$)/.test(text.slice(block.end));
    out += alone && rendered ? `${rendered}\n\n` : rendered;
    pos = block.end > pos ? block.end : next;
    while (text[pos] === "\n") pos += 1;
  }
  return out.replace(/\n{3,}/g, "\n\n");
}
