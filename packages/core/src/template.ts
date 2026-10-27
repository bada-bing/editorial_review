/**
 * A scenario's structure: one block per element, written as a template.
 *
 *   bullet
 *     - {{line}}
 *       {{line}}*
 *
 * A block is the element's name at the margin, indented header lines
 * `key: value`, an empty line, and the indented template: literal text around
 * placeholders, drawn as the output looks. A placeholder is a child, in order,
 * with `?`, `+` or `*` for repetition; `{{text}}` is the one built-in, the
 * characters a leaf holds. The first block is the root.
 */

export type Quantifier = "" | "?" | "+" | "*";

export interface Placeholder {
  kind: "placeholder";
  name: string;
  quantifier: Quantifier;
}
export interface Literal {
  kind: "literal";
  text: string;
}
export type Piece = Placeholder | Literal;

export interface TemplateLine {
  /** The indentation drawn before the line, within the block's template. */
  indent: string;
  pieces: Piece[];
}

export interface Block {
  name: string;
  headers: Record<string, string>;
  lines: TemplateLine[];
  /** The children in order, adjacent placeholders of one name merged: `line`, `line+` is `line+`. */
  model: { name: string; min: number; max: number }[];
  /** True for a block whose template is `{{text}}`: a leaf. */
  leaf: boolean;
}

export interface Templates {
  root: string;
  blocks: Map<string, Block>;
}

export class TemplateError extends Error {}

export function parseTemplates(source: string): Templates {
  const blocks = new Map<string, Block>();
  let current: { name: string; headerLines: string[]; bodyLines: string[]; inBody: boolean } | undefined;
  const finish = () => {
    if (!current) return;
    blocks.set(current.name, buildBlock(current.name, current.headerLines, current.bodyLines));
    current = undefined;
  };
  for (const raw of source.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line.startsWith("#")) continue;
    if (line !== "" && !/^\s/.test(line)) {
      finish();
      if (!/^[a-z][a-z0-9_-]*$/.test(line)) throw new TemplateError(`"${line}" is not an element name`);
      current = { name: line, headerLines: [], bodyLines: [], inBody: false };
      continue;
    }
    if (!current) {
      if (line === "") continue;
      throw new TemplateError(`text before the first block: "${line}"`);
    }
    if (!current.inBody) {
      if (line === "") {
        if (current.headerLines.length) current.inBody = true;
        continue;
      }
      if (/^\s+[a-z]+:\s/.test(line) && !line.includes("{{")) {
        current.headerLines.push(line.trim());
        continue;
      }
      current.inBody = true;
    }
    current.bodyLines.push(line);
  }
  finish();
  if (blocks.size === 0) throw new TemplateError("no blocks");
  const root = blocks.keys().next().value!;
  for (const b of blocks.values()) {
    for (const m of b.model) if (m.name !== "text" && !blocks.has(m.name)) throw new TemplateError(`${b.name} uses {{${m.name}}}, which has no block`);
  }
  return { root, blocks };
}

function buildBlock(name: string, headerLines: string[], bodyLines: string[]): Block {
  const headers: Record<string, string> = {};
  for (const h of headerLines) {
    const m = /^([a-z]+):\s+(.*)$/.exec(h);
    if (!m) throw new TemplateError(`${name}: "${h}" is not a header`);
    headers[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  while (bodyLines.length && bodyLines.at(-1) === "") bodyLines.pop();
  while (bodyLines.length && bodyLines[0] === "") bodyLines.shift();
  if (!bodyLines.length) throw new TemplateError(`${name} has no template`);
  const indentWidth = Math.min(...bodyLines.filter((l) => l !== "").map((l) => /^\s*/.exec(l)![0].length));
  const lines: TemplateLine[] = bodyLines.map((l) => {
    const rest = l.slice(indentWidth);
    const indent = /^\s*/.exec(rest)![0];
    return { indent, pieces: parsePieces(rest.slice(indent.length), name) };
  });
  const model: Block["model"] = [];
  for (const p of lines.flatMap((l) => l.pieces)) {
    if (p.kind !== "placeholder") continue;
    const [min, max] = p.quantifier === "" ? [1, 1] : p.quantifier === "?" ? [0, 1] : p.quantifier === "+" ? [1, Infinity] : [0, Infinity];
    const last = model.at(-1);
    if (last && last.name === p.name) {
      last.min += min;
      last.max = last.max === Infinity || max === Infinity ? Infinity : last.max + max;
    } else model.push({ name: p.name, min, max });
  }
  const leaf = model.length === 1 && model[0]!.name === "text";
  if (model.some((m) => m.name === "text") && !leaf) throw new TemplateError(`${name}: {{text}} stands alone in a leaf`);
  return { name, headers, lines, model, leaf };
}

function parsePieces(text: string, block: string): Piece[] {
  const pieces: Piece[] = [];
  const re = /\{\{\s*([a-z][a-z0-9_-]*)\s*\}\}([?+*]?)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) pieces.push({ kind: "literal", text: text.slice(last, m.index) });
    pieces.push({ kind: "placeholder", name: m[1]!, quantifier: m[2] as Quantifier });
    last = m.index! + m[0].length;
  }
  if (last < text.length) pieces.push({ kind: "literal", text: text.slice(last) });
  void block; // an empty template line is a literal empty output line
  return pieces;
}

/** `width` for a leaf: the limit of an output line, the nearest container that sets one winning over the leaf's own. */
export function widthOf(chain: Block[]): number | undefined {
  const order = [...chain.slice(0, -1).reverse(), chain[chain.length - 1]!];
  for (const block of order) {
    const w = block.headers["width"];
    if (w === undefined) continue;
    if (w === "none") return undefined;
    const n = Number(w);
    if (!Number.isInteger(n) || n < 1) throw new TemplateError(`${block.name}: width is a limit or none, not ${w}`);
    return n;
  }
  return undefined;
}
