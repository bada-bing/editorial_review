import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Scenario {
  name: string;
  /** spec.md as written. */
  spec: string;
  /** Each example file by its id, as written. */
  examples: Record<string, string>;
}

/** The scenarios folder, read on every call so a guideline changed mid-review is seen by the next draft. */
export class Scenarios {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  list(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.root, d.name, "spec.md")))
      .map((d) => d.name)
      .sort();
  }

  has(name: string): boolean {
    return this.list().includes(name);
  }

  get(name: string): Scenario | undefined {
    if (!this.has(name)) return undefined;
    const dir = join(this.root, name);
    const examplesDir = join(dir, "examples");
    const examples: Record<string, string> = {};
    if (existsSync(examplesDir)) {
      for (const f of readdirSync(examplesDir).filter((f) => f.endsWith(".md")).sort()) {
        examples[f.slice(0, -3)] = readFileSync(join(examplesDir, f), "utf8");
      }
    }
    return { name, spec: readFileSync(join(dir, "spec.md"), "utf8"), examples };
  }
}
