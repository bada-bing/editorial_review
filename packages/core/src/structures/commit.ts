// The commit scenario's adapter: the templates in the spec's fenced `template` block.
import type { Structure } from "../structure.ts";
import { parseTemplates } from "../template.ts";
import { templateStructure } from "./templates.ts";

export const commit = (spec: string): Structure => templateStructure(parseTemplates(templateBlock(spec)));

/** The fenced `template` block of a spec, as written. */
export function templateBlock(spec: string): string {
  const m = /```template\n([\s\S]*?)```/.exec(spec);
  if (!m) throw new Error("the spec has no ```template block");
  return m[1]!;
}
