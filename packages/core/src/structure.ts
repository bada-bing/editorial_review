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

/** One line of the output and the addressable leaf it came from, if any. */
export interface OutputLine {
  text: string;
  lineId?: string;
}

export interface Structure {
  /** Refuses a tree that does not fit, with a DraftError naming the element and what was expected. */
  check(tree: Node): void;
  /** True for a leaf that is addressed: given an id, commented on and amended. */
  addressable(node: Node): boolean;
  /** An addressable leaf holding `text`, for an amend to put in place of one. */
  leaf(text: string): Node;
  /** The output, line by line, each tied to the leaf it came from. */
  outputLines(tree: Node): OutputLine[];
  /** A tree built from typed text: what the page submits. */
  fromText(text: string): Node;
}

/** Each adapter by the name of its scenario, built from the scenario's spec. */
const adapters: Record<string, (spec: string) => Structure> = { commit };

export class NoStructure extends Error {}

export function structureOf(scenario: string, spec: string): Structure {
  const adapter = adapters[scenario];
  if (!adapter) throw new NoStructure(`the ${scenario} scenario has no structure adapter`);
  return adapter(spec);
}
