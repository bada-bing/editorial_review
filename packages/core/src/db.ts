import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { schema } from "./schema.ts";

/** Opens the database at `path`, creating it and its schema if needed. `:memory:` works. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  // The schema is idempotent except for the ALTER TABLE lines, which add a column once; one that exists already is skipped.
  for (const statement of schema.split(/;\n/).map((x) => x.trim()).filter(Boolean)) {
    try {
      db.exec(statement);
    } catch (e) {
      if (!/duplicate column name/.test((e as Error).message)) throw e;
    }
  }
  return db;
}
