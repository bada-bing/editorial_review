import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { randomBytes } from "node:crypto";
import { type Block, type Templates, TemplateError, widthOf } from "./template.ts";

/** An element of a draft. A leaf holds text and no children. */
export interface Node {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
  text?: string;
}

export class DraftError extends Error {}

export const newLineId = (): string => randomBytes(4).toString("hex");

// ---- XML in and out

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", trimValues: false, parseTagValue: false, parseAttributeValue: false, commentPropName: "#comment", cdataPropName: "#cdata" });
const builder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", format: true, indentBy: "  ", suppressEmptyNode: false });

type Ordered = Record<string, unknown>;

export function parseXml(xml: string): Node {
  let items: Ordered[];
  try {
    items = parser.parse(xml) as Ordered[];
  } catch (e) {
    throw new DraftError(`the draft is not well-formed XML: ${(e as Error).message}`);
  }
  const roots = items.map(fromOrdered).filter((n): n is Node => n !== undefined);
  if (roots.length !== 1) throw new DraftError(`the draft must have one root element, not ${roots.length}`);
  return roots[0]!;
}

function fromOrdered(item: Ordered): Node | undefined {
  const name = Object.keys(item).find((k) => k !== ":@");
  if (!name || name === "#comment" || name === "#cdata") return undefined;
  if (name === "#text") return undefined;
  const attrs = (item[":@"] as Record<string, string> | undefined) ?? {};
  const inner = item[name] as Ordered[];
  const children = inner.map(fromOrdered).filter((n): n is Node => n !== undefined);
  const texts = inner.filter((i) => "#text" in i).map((i) => String(i["#text"]));
  if (children.length === 0) return { name, attrs, children, text: texts.join("").trim() };
  if (texts.some((t) => t.trim() !== "")) throw new DraftError(`<${name}> mixes text and elements`);
  return { name, attrs, children };
}

export function toXml(node: Node): string {
  return (builder.build([toOrdered(node)]) as string).replace(/\n$/, "") + "\n";
}

function toOrdered(node: Node): Ordered {
  const inner: Ordered[] = node.children.length ? node.children.map(toOrdered) : [{ "#text": node.text ?? "" }];
  return Object.keys(node.attrs).length ? { [node.name]: inner, ":@": node.attrs } : { [node.name]: inner };
}

// ---- checking against the templates

/** Refuses a tree that does not fit the templates, naming the element and what was expected. */
export function check(tree: Node, templates: Templates): void {
  if (tree.name !== templates.root) throw new DraftError(`the root is <${tree.name}>, expected <${templates.root}>`);
  checkNode(tree, templates, tree.name);
  checkWidths(tree, templates);
}

function checkNode(node: Node, templates: Templates, path: string): void {
  const block = templates.blocks.get(node.name);
  if (!block) throw new DraftError(`<${node.name}> at ${path} is not an element of this scenario`);
  if (block.leaf) {
    if (node.children.length) throw new DraftError(`<${node.name}> at ${path} holds text, not elements`);
    if ((node.text ?? "").trim() === "") throw new DraftError(`<${node.name}> at ${path} is empty`);
    return;
  }
  if (node.text !== undefined && node.text.trim() !== "") throw new DraftError(`<${node.name}> at ${path} needs a <${block.model[0]!.name}>, not bare text`);
  let i = 0;
  for (const m of block.model) {
    let taken = 0;
    while (taken < m.max && node.children[i]?.name === m.name) {
      i++;
      taken++;
    }
    if (taken < m.min) {
      const found = node.children[i] ? `<${node.children[i]!.name}>` : "nothing";
      throw new DraftError(`<${node.name}> at ${path} needs ${m.min === 1 && m.max === 1 ? "a" : `at least ${m.min}`} <${m.name}> where ${found} is`);
    }
  }
  if (i < node.children.length) throw new DraftError(`<${node.children[i]!.name}> at ${path} is not allowed there`);
  node.children.forEach((c, k) => checkNode(c, templates, `${path}/${c.name}[${nth(node.children, k)}]`));
}

// ---- lines

export const LINE = "line";

export interface Row {
  n: number;
  id: string;
  text: string;
  /** The comments this line answers, as the writer set them. */
  answers: string[];
  path: string;
}

/** Every line without an id gets one; returns the tree. */
export function assignIds(tree: Node): Node {
  for (const l of lines(tree)) if (!l.attrs["id"]) l.attrs["id"] = newLineId();
  return tree;
}

export function lines(tree: Node): Node[] {
  const out: Node[] = [];
  const walk = (n: Node) => {
    if (n.name === LINE) out.push(n);
    n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

/** The review view: one row per line, numbered in document order. */
export function rows(tree: Node): Row[] {
  const out: Row[] = [];
  const walk = (n: Node, path: string) => {
    if (n.name === LINE) {
      out.push({ n: out.length + 1, id: n.attrs["id"] ?? "", text: n.text ?? "", answers: (n.attrs["answers"] ?? "").split(/\s+/).filter(Boolean), path });
      return;
    }
    n.children.forEach((c, k) => walk(c, `${path}/${c.name}[${nth(n.children, k)}]`));
  };
  walk(tree, tree.name);
  return out;
}

/** A child's position among its siblings of the same name, 1-based, as XPath counts. */
function nth(children: Node[], k: number): number {
  return children.slice(0, k + 1).filter((c) => c.name === children[k]!.name).length;
}

export function findLine(tree: Node, id: string): { parent: Node; index: number; line: Node } | undefined {
  const walk = (n: Node): { parent: Node; index: number; line: Node } | undefined => {
    for (let k = 0; k < n.children.length; k++) {
      const c = n.children[k]!;
      if (c.name === LINE && c.attrs["id"] === id) return { parent: n, index: k, line: c };
      const found = walk(c);
      if (found) return found;
    }
    return undefined;
  };
  return walk(tree);
}

// ---- comparing versions

export type Change = "unchanged" | "changed" | "new";

/** Each line of `current` against `previous`, by id, and the ids that vanished. */
export function compare(previous: Node | undefined, current: Node): { rows: (Row & { change: Change })[]; removed: Row[] } {
  const before = new Map(previous ? rows(previous).map((r) => [r.id, r]) : []);
  const now = rows(current);
  const seen = new Set<string>();
  const out = now.map((r) => {
    seen.add(r.id);
    const b = before.get(r.id);
    const change: Change = !b ? "new" : b.text === r.text ? "unchanged" : "changed";
    return { ...r, change };
  });
  return { rows: out, removed: [...before.values()].filter((r) => !seen.has(r.id)) };
}

// ---- output

/** One line of the output and the line of the tree it came from, if any. */
export interface OutputLine {
  text: string;
  lineId?: string;
}

/** The output: the templates applied, literals as drawn, separators between repetitions. A line is never broken. */
export function render(tree: Node, templates: Templates): string {
  return outputLines(tree, templates).map((l) => l.text).join("\n").replace(/\n*$/, "") + "\n";
}

export function outputLines(tree: Node, templates: Templates): OutputLine[] {
  return renderNode(tree, templates, []);
}

/** Refuses a tree whose output has a line longer than its `width`, naming the line. */
export function checkWidths(tree: Node, templates: Templates): void {
  const widths = new Map<string, number | undefined>();
  const walk = (n: Node, chain: Block[]) => {
    const block = templates.blocks.get(n.name)!;
    const here = [...chain, block];
    if (block.leaf) widths.set(n.attrs["id"] ?? "", widthOf(here));
    n.children.forEach((c) => walk(c, here));
  };
  walk(tree, []);
  for (const out of outputLines(tree, templates)) {
    const width = out.lineId === undefined ? undefined : widths.get(out.lineId);
    if (width !== undefined && out.text.length > width) {
      throw new DraftError(`line ${out.lineId} comes out ${out.text.length} characters long, over the limit of ${width}: "${out.text.slice(0, 40)}…"`);
    }
  }
}

function renderNode(node: Node, templates: Templates, chain: Block[]): OutputLine[] {
  const block = templates.blocks.get(node.name)!;
  const here = [...chain, block];
  if (block.leaf) return [{ text: node.text ?? "", ...(node.attrs["id"] ? { lineId: node.attrs["id"] } : {}) }];
  const separator = block.headers["separator"];
  const sep = separator === undefined ? undefined : separator === "blank" ? "\n\n" : separator === "newline" ? "\n" : separator;
  let next = 0;
  const output: OutputLine[] = [];
  for (const tl of block.lines) {
    if (!tl.pieces.length) {
      output.push({ text: "" });
      continue;
    }
    // The line being built: literals and inline children run together.
    let current: OutputLine = { text: tl.indent };
    const flush = () => {
      if (current.text !== tl.indent) output.push(current);
      current = { text: tl.indent };
    };
    for (const piece of tl.pieces) {
      if (piece.kind === "literal") {
        current.text += piece.text;
        continue;
      }
      const max = piece.quantifier === "" || piece.quantifier === "?" ? 1 : Infinity;
      const taken: Node[] = [];
      while (taken.length < max && node.children[next]?.name === piece.name) taken.push(node.children[next++]!);
      const parts = taken.map((c) => renderNode(c, templates, here));
      if (sep !== undefined && sep !== "\n" && sep !== "\n\n") {
        // Repetitions joined into the running line with the separator.
        const joined = parts.map((p) => p.map((l) => l.text).join("\n")).join(sep);
        current.text += joined;
        if (parts.length === 1 && parts[0]!.length === 1 && parts[0]![0]!.lineId) current.lineId = parts[0]![0]!.lineId;
        continue;
      }
      // Each repetition on lines of its own: the first takes the running literal, the rest the same indentation.
      parts.forEach((p, i) => {
        if (i > 0 && sep === "\n\n") output.push({ text: "" });
        const [first, ...rest] = p;
        if (first) output.push({ text: current.text + first.text, ...(first.lineId ? { lineId: first.lineId } : {}) });
        const pad = " ".repeat(current.text.length);
        for (const r of rest) output.push({ text: r.text === "" ? "" : pad + r.text, ...(r.lineId ? { lineId: r.lineId } : {}) });
        current = { text: tl.indent };
      });
    }
    flush();
  }
  return output;
}

// ---- the textarea: text to tree by the templates

/**
 * Builds a tree from typed text: paragraphs separated by empty lines, each
 * line a <line>. The root's children take the paragraphs in order; a child
 * whose own template starts with a literal marker, such as "- ", takes every
 * marked line as one of its items with the unmarked lines after it; a child
 * of lines takes a whole paragraph. Enough for a commit and a Slack message.
 */
export function treeFromText(text: string, templates: Templates): Node {
  const paragraphs: string[][] = [];
  let cur: string[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    if (raw.trim() === "") {
      if (cur.length) paragraphs.push(cur);
      cur = [];
    } else cur.push(raw.trimEnd());
  }
  if (cur.length) paragraphs.push(cur);
  const root = templates.blocks.get(templates.root)!;
  const node: Node = { name: root.name, attrs: {}, children: [] };
  let p = 0;
  for (const m of root.model) {
    const child = templates.blocks.get(m.name)!;
    let taken = 0;
    while (taken < m.max && p < paragraphs.length) {
      node.children.push(...fill(child, paragraphs[p]!, templates));
      p++;
      taken++;
    }
  }
  if (p < paragraphs.length) throw new DraftError(`the text has more paragraphs than a ${root.name} takes`);
  return node;
}

function fill(block: Block, paragraph: string[], templates: Templates): Node[] {
  const linesOnly = block.model.length === 1 && block.model[0]!.name === LINE;
  if (linesOnly) return [{ name: block.name, attrs: {}, children: paragraph.map((t) => ({ name: LINE, attrs: {}, children: [], text: t.trim() })) }];
  // A container of items marked by a literal on the item's first template line.
  const itemModel = block.model.length === 1 ? block.model[0]! : undefined;
  const item = itemModel ? templates.blocks.get(itemModel.name) : undefined;
  const marker = item?.lines[0]?.pieces[0];
  if (item && marker?.kind === "literal") {
    const items: Node[] = [];
    for (const l of paragraph) {
      const t = l.trim();
      if (t.startsWith(marker.text.trim())) items.push({ name: item.name, attrs: {}, children: [{ name: LINE, attrs: {}, children: [], text: t.slice(marker.text.trim().length).trim() }] });
      else if (items.length) items.at(-1)!.children.push({ name: LINE, attrs: {}, children: [], text: t });
      else throw new DraftError(`a ${item.name} starts with "${marker.text.trim()}", not "${t}"`);
    }
    return [{ name: block.name, attrs: {}, children: items }];
  }
  throw new TemplateError(`${block.name} cannot be built from typed text`);
}
