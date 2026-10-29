import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { randomBytes } from "node:crypto";
import type { Structure } from "./structure.ts";

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

// ---- addressable leaves, as the structure says which they are

export interface Row {
  n: number;
  id: string;
  text: string;
  /** The comments this leaf answers, as the writer set them. */
  answers: string[];
  path: string;
}

/** Every addressable leaf without an id gets one; returns the tree. */
export function assignIds(tree: Node, structure: Structure): Node {
  for (const l of leaves(tree, structure)) if (!l.attrs["id"]) l.attrs["id"] = newLineId();
  return tree;
}

export function leaves(tree: Node, structure: Structure): Node[] {
  const out: Node[] = [];
  const walk = (n: Node) => {
    if (structure.addressable(n)) out.push(n);
    n.children.forEach(walk);
  };
  walk(tree);
  return out;
}

/** The review view: one row per addressable leaf, numbered in document order. */
export function rows(tree: Node, structure: Structure): Row[] {
  const out: Row[] = [];
  const walk = (n: Node, path: string) => {
    if (structure.addressable(n)) {
      out.push({ n: out.length + 1, id: n.attrs["id"] ?? "", text: n.text ?? "", answers: (n.attrs["answers"] ?? "").split(/\s+/).filter(Boolean), path });
      return;
    }
    n.children.forEach((c, k) => walk(c, `${path}/${c.name}[${nth(n.children, k)}]`));
  };
  walk(tree, tree.name);
  return out;
}

/** A child's position among its siblings of the same name, 1-based, as XPath counts. */
export function nth(children: Node[], k: number): number {
  return children.slice(0, k + 1).filter((c) => c.name === children[k]!.name).length;
}

export function findLeaf(tree: Node, id: string, structure: Structure): { parent: Node; index: number; leaf: Node } | undefined {
  const walk = (n: Node): { parent: Node; index: number; leaf: Node } | undefined => {
    for (let k = 0; k < n.children.length; k++) {
      const c = n.children[k]!;
      if (structure.addressable(c) && c.attrs["id"] === id) return { parent: n, index: k, leaf: c };
      const found = walk(c);
      if (found) return found;
    }
    return undefined;
  };
  return walk(tree);
}

// ---- comparing versions

export type Change = "unchanged" | "changed" | "new";

/** Each leaf of `current` against `previous`, by id, and the ids that vanished. */
export function compare(previous: Node | undefined, current: Node, structure: Structure): { rows: (Row & { change: Change })[]; removed: Row[] } {
  const before = new Map(previous ? rows(previous, structure).map((r) => [r.id, r]) : []);
  const now = rows(current, structure);
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

/** The output as its destination takes it. A line is never broken. */
export function render(tree: Node, structure: Structure): string {
  return structure.outputLines(tree).map((l) => l.text).join("\n").replace(/\n*$/, "") + "\n";
}
