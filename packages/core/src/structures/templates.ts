// A structure read off templates, the notation the commit scenario's spec is
// written in. Its addressable leaf is `line`, a name known only here.
import type { OutputLine, Structure } from "../structure.ts";
import { type Block, type Templates, TemplateError, widthOf } from "../template.ts";
import { DraftError, type Node, nth } from "../tree.ts";

const LINE = "line";

export function templateStructure(templates: Templates): Structure {
  return {
    check: (tree) => check(tree, templates),
    addressable: (node) => node.name === LINE,
    leaf: (text) => ({ name: LINE, attrs: {}, children: [], text: text.trim() }),
    outputLines: (tree) => outputLines(tree, templates),
    fromText: (text) => treeFromText(text, templates),
  };
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

// ---- output

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
