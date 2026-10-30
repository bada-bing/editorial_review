/**
 * A scenario's structure, behind an adapter: what a draft of it consists of,
 * and the one place that knows its elements by name. Nothing outside an
 * adapter names an element; the rest of the framework sees the addressable
 * leaves, the output and the errors.
 *
 * Until a generic notation covers every structure, each scenario has an
 * adapter of its own, registered under the scenario's name.
 */
import type { Node } from "./tree.ts";
import { commit } from "./structures/commit.ts";
import { slack } from "./structures/slack.ts";

/** One line of the output and the addressable leaf it came from, if any. */
export interface OutputLine {
  text: string;
  lineId?: string;
}

/** How an addressable leaf sits in the draft view: after an empty line of the output, or after a break. */
export interface Placement {
  gap: boolean;
  br: boolean;
}

export interface Structure {
  /** Refuses a tree that does not fit, with a DraftError naming the element and what was expected. */
  check(tree: Node): void;
  /** True for a leaf that is addressed: given an id, commented on and amended. */
  addressable(node: Node): boolean;
  /** What an edit of each addressable leaf shows, by its id: its text, and whatever an edit of it also changes. */
  editTexts(tree: Node): Map<string, string>;
  /** Puts `lines` in place of the leaf with `id` and what its edit showed with it; the first leaf put in keeps the id. */
  amend(tree: Node, id: string, lines: string[]): void;
  /** The output, line by line, each tied to the leaf it came from. */
  outputLines(tree: Node): OutputLine[];
  /** A tree built from typed text: what the page submits. */
  fromText(text: string): Node;
  /** The tree as typed text, which `fromText` reads back to the same tree: what the page prefills. */
  toText(tree: Node): string;
  /** Each addressable leaf's placement, by its id. */
  placement(tree: Node): Map<string, Placement>;
  /** The path of the file defining the notation the spec's structure is written in, when it has one. */
  notation?: string;
}

/** Each adapter by the name of its scenario, built from the scenario's spec. */
const adapters: Record<string, (spec: string) => Structure> = { commit, slack };

export class NoStructure extends Error {}

export function structureOf(scenario: string, spec: string): Structure {
  const adapter = adapters[scenario];
  if (!adapter) throw new NoStructure(`the ${scenario} scenario has no structure adapter`);
  return adapter(spec);
}
