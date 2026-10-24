import type { DatabaseSync } from "node:sqlite";
import { NotFound } from "./errors.ts";

export type ConnectionId = number;
export type TextId = number;
/** An actor is me or a connection. In the database, NULL is me. */
export type Actor = "me" | { connection: ConnectionId };
export type State = "drafting" | "in review" | "approved";
/** A scenario's context items, by name: diff, log, intent. */
export type Context = Record<string, string>;

export interface TextState {
  id: TextId;
  scenario: string;
  context: Context;
  writer: Actor;
  openedAt: string;
  latestVersion: number | null;
  state: State;
  /** Who the text waits on; empty once approved. */
  waitsOn: { actor: Actor; role: "writer" | "reviewer" }[];
}

const toActor = (connectionId: number | null): Actor =>
  connectionId === null ? "me" : { connection: connectionId };
const toColumn = (actor: Actor): number | null => (actor === "me" ? null : actor.connection);

interface StateRow {
  text_id: number;
  scenario: string;
  context: string;
  writer_connection_id: number | null;
  opened_at: string;
  latest_version: number | null;
  state: State;
}

/** Every rule of the record, over one open database. Only `server` holds one. */
export class Core {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** The connection for a tmux window, found by its target or created. */
  connect(target: string, label: string): ConnectionId {
    const found = this.db.prepare("SELECT id FROM connection WHERE target = ?").get(target) as
      | { id: number }
      | undefined;
    if (found) return found.id;
    const r = this.db.prepare("INSERT INTO connection (target, label) VALUES (?, ?)").run(target, label);
    return Number(r.lastInsertRowid);
  }

  /** Opens a text; it waits on its writer for the first draft. */
  openText(scenario: string, writer: Actor, context: Context = {}): TextId {
    const r = this.db
      .prepare("INSERT INTO text (scenario, writer_connection_id, context) VALUES (?, ?, ?)")
      .run(scenario, toColumn(writer), JSON.stringify(context));
    return Number(r.lastInsertRowid);
  }

  getText(id: TextId): TextState {
    const row = this.db
      .prepare("SELECT s.*, t.context, t.opened_at FROM text_state s JOIN text t ON t.id = s.text_id WHERE s.text_id = ?")
      .get(id) as StateRow | undefined;
    if (!row) throw new NotFound("text", id);
    return this.toState(row);
  }

  /** Every text not yet approved, in the order the texts were opened. */
  listOpenTexts(): TextState[] {
    const rows = this.db
      .prepare(
        "SELECT s.*, t.context, t.opened_at FROM text_state s JOIN text t ON t.id = s.text_id WHERE s.state <> 'approved' ORDER BY t.opened_at, t.id",
      )
      .all() as unknown as StateRow[];
    return rows.map((r) => this.toState(r));
  }

  /** Deletes the text with its drafts, reviews and comments. */
  drop(id: TextId): void {
    const r = this.db.prepare("DELETE FROM text WHERE id = ?").run(id);
    if (r.changes === 0) throw new NotFound("text", id);
  }

  private toState(row: StateRow): TextState {
    const waits = this.db
      .prepare("SELECT connection_id, role FROM text_waits_on WHERE text_id = ?")
      .all(row.text_id) as unknown as { connection_id: number | null; role: "writer" | "reviewer" }[];
    return {
      id: row.text_id,
      scenario: row.scenario,
      context: JSON.parse(row.context) as Context,
      writer: toActor(row.writer_connection_id),
      openedAt: row.opened_at,
      latestVersion: row.latest_version,
      state: row.state,
      waitsOn: waits.map((w) => ({ actor: toActor(w.connection_id), role: w.role })),
    };
  }
}
