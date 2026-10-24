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
  db.exec(schema);
  return db;
}

export type ConnectionId = number;
export type TextId = number;
/** An actor is me or a connection. */
export type Actor = "me" | { connection: ConnectionId };

export type State = "drafting" | "in review" | "approved";

export interface TextState {
  id: TextId;
  scenario: string;
  writer: Actor;
  latestVersion: number | null;
  state: State;
  /** Who the text waits on; empty once approved. */
  waitsOn: { actor: Actor; role: "writer" | "reviewer" }[];
}

const actor = (connectionId: number | null): Actor =>
  connectionId === null ? "me" : { connection: connectionId };

/** The derived state of a text, read from the views. Undefined for an unknown id. */
export function getState(db: DatabaseSync, id: TextId): TextState | undefined {
  const row = db
    .prepare("SELECT * FROM text_state WHERE text_id = ?")
    .get(id) as
    | { scenario: string; writer_connection_id: number | null; latest_version: number | null; state: State }
    | undefined;
  if (!row) return undefined;
  const waits = db
    .prepare("SELECT connection_id, role FROM text_waits_on WHERE text_id = ?")
    .all(id) as { connection_id: number | null; role: "writer" | "reviewer" }[];
  return {
    id,
    scenario: row.scenario,
    writer: actor(row.writer_connection_id),
    latestVersion: row.latest_version,
    state: row.state,
    waitsOn: waits.map((w) => ({ actor: actor(w.connection_id), role: w.role })),
  };
}
