// The Slack scenario's adapter, written by hand: a message of paragraphs, a
// paragraph of sentences and breaks. The template notation repeats one element,
// and a paragraph mixes two, so this structure is not read off the spec.
import type { OutputLine, Placement, Structure } from "../structure.ts";
import { DraftError, type Node, nth } from "../tree.ts";

const MESSAGE = "message";
const PARAGRAPH = "paragraph";
const SENTENCE = "sentence";
const BR = "br";

/** A line of typed text that holds only this is a break. */
const TYPED_BR = "<br>";

export const slack = (): Structure => ({
  check,
  addressable: (node) => node.name === SENTENCE,
  editTexts,
  amend,
  outputLines,
  fromText,
  toText,
  placement,
});

function check(tree: Node): void {
  if (tree.name !== MESSAGE) throw new DraftError(`the root is <${tree.name}>, expected <${MESSAGE}>`);
  if (tree.children.length === 0) throw new DraftError(`<${MESSAGE}> needs at least 1 <${PARAGRAPH}>`);
  tree.children.forEach((p, k) => {
    const path = `${MESSAGE}/${p.name}[${nth(tree.children, k)}]`;
    if (p.name !== PARAGRAPH) throw new DraftError(`<${p.name}> at ${path} is not allowed there, a <${MESSAGE}> holds <${PARAGRAPH}>s`);
    checkParagraph(p, path);
  });
}

function checkParagraph(p: Node, path: string): void {
  if (!p.children.some((c) => c.name === SENTENCE)) throw new DraftError(`<${PARAGRAPH}> at ${path} needs at least 1 <${SENTENCE}>`);
  p.children.forEach((c, k) => {
    const at = `${path}/${c.name}[${nth(p.children, k)}]`;
    if (c.name === SENTENCE) {
      if (c.children.length) throw new DraftError(`<${SENTENCE}> at ${at} holds text, not elements`);
      if ((c.text ?? "").trim() === "") throw new DraftError(`<${SENTENCE}> at ${at} is empty`);
      return;
    }
    if (c.name !== BR) throw new DraftError(`<${c.name}> at ${at} is not allowed there, a <${PARAGRAPH}> holds <${SENTENCE}>s and <${BR}>s`);
    if (c.children.length || (c.text ?? "").trim() !== "") throw new DraftError(`<${BR}> at ${at} holds nothing`);
    // A break stands between two sentences; anything else is a paragraph's end or an empty line.
    if (p.children[k - 1]?.name !== SENTENCE || p.children[k + 1]?.name !== SENTENCE) throw new DraftError(`<${BR}> at ${at} stands between two <${SENTENCE}>s`);
  });
}

/** Each paragraph's sentences joined by a space, a break starting a new line, an empty line between paragraphs. */
function outputLines(tree: Node): OutputLine[] {
  const out: OutputLine[] = [];
  tree.children.forEach((p, i) => {
    if (i > 0) out.push({ text: "" });
    let run: Node[] = [];
    const flush = () => {
      if (!run.length) return;
      const only = run.length === 1 ? run[0]!.attrs["id"] : undefined;
      out.push({ text: run.map((s) => s.text ?? "").join(" "), ...(only ? { lineId: only } : {}) });
      run = [];
    };
    for (const c of p.children) {
      if (c.name === BR) flush();
      else run.push(c);
    }
    flush();
  });
  return out;
}

/** Typed text: an empty line between paragraphs, a sentence per line, and `<br>` alone on a line for a break. */
function fromText(text: string): Node {
  const message: Node = { name: MESSAGE, attrs: {}, children: [] };
  let paragraph: Node | undefined;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (line === "") {
      paragraph = undefined;
      continue;
    }
    if (!paragraph) {
      paragraph = { name: PARAGRAPH, attrs: {}, children: [] };
      message.children.push(paragraph);
    }
    paragraph.children.push(line === TYPED_BR ? { name: BR, attrs: {}, children: [], text: "" } : { name: SENTENCE, attrs: {}, children: [], text: line });
  }
  return message;
}

function toText(tree: Node): string {
  return tree.children.map((p) => p.children.map((c) => (c.name === BR ? TYPED_BR : (c.text ?? ""))).join("\n")).join("\n\n");
}

/** A paragraph's first sentence after the first paragraph follows a gap; a sentence after a break follows the break. */
function placement(tree: Node): Map<string, Placement> {
  const out = new Map<string, Placement>();
  tree.children.forEach((p, i) => {
    p.children.forEach((c, k) => {
      if (c.name !== SENTENCE) return;
      out.set(c.attrs["id"] ?? "", { gap: i > 0 && k === 0, br: p.children[k - 1]?.name === BR });
    });
  });
  return out;
}

/** A sentence's text, with the break after it as a line of its own, so an edit can remove the break or add one. */
function editTexts(tree: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of tree.children) {
    p.children.forEach((c, k) => {
      if (c.name === SENTENCE) out.set(c.attrs["id"] ?? "", (c.text ?? "") + (p.children[k + 1]?.name === BR ? `\n${TYPED_BR}` : ""));
    });
  }
  return out;
}

/** Typed lines in place of a sentence and the break after it; a break left at a paragraph's edge or doubled goes, and so does an emptied paragraph. */
function amend(tree: Node, id: string, lines: string[]): void {
  for (const p of tree.children) {
    const k = p.children.findIndex((c) => c.name === SENTENCE && c.attrs["id"] === id);
    if (k === -1) continue;
    const span = p.children[k + 1]?.name === BR ? 2 : 1;
    let kept = false;
    const put = lines
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .map((l): Node => {
        if (l === TYPED_BR) return { name: BR, attrs: {}, children: [], text: "" };
        const sentence: Node = { name: SENTENCE, attrs: kept ? {} : { id }, children: [], text: l };
        kept = true;
        return sentence;
      });
    p.children.splice(k, span, ...put);
    p.children = p.children.filter((c, i, all) => c.name !== BR || (i > 0 && i < all.length - 1 && all[i - 1]!.name !== BR));
    tree.children = tree.children.filter((q) => q.children.length > 0);
    return;
  }
}
