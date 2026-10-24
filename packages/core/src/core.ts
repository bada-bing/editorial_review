import type { DatabaseSync } from "node:sqlite";
import { NotFound, NotYourTurn, ReviewRunning, TextApproved } from "./errors.ts";

export type ConnectionId = number;
export type TextId = number;
/** An actor is me or a connection. In the database, NULL is me. */
export type Actor = "me" | { connection: ConnectionId };
export type State = "drafting" | "in review" | "approved";
/** A scenario's context items, by name: diff, log, intent. */
export type Context = Record<string, string>;

export type Version = number;
export type Origin = "submitted" | "amended";

export interface Comment {
  id: number;
  author: string;
  content: string;
  createdAt: string;
}

/** A thread on one line, or on the whole draft when `line` is null. */
export interface Thread {
  line: number | null;
  comments: Comment[];
}

export interface Draft {
  textId: TextId;
  version: Version;
  origin: Origin;
  /** Review form: one sentence per line, 1-based line numbers over every line, empty ones included. */
  content: string;
  createdAt: string;
  threads: Thread[];
}

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

  /**
   * Saves the writer's next version. Only while drafting; the text is then in
   * review and waits on me, until I submit my review of this version.
   */
  submitDraft(id: TextId, content: string): Version {
    const t = this.getText(id);
    if (t.state === "approved") throw new TextApproved(id);
    if (t.state !== "drafting") throw new NotYourTurn("submit a draft", t.state);
    const version = (t.latestVersion ?? 0) + 1;
    this.insertDraft(id, version, "submitted", content);
    return version;
  }

  /**
   * Replaces line `line` of the current draft with `lines`, as a new amended
   * version. Only in review, and only while no requested review is running.
   * Every thread moves onto the new version: one on a line below shifts by
   * the change in length, one on the line stays.
   */
  amendDraft(id: TextId, line: number, lines: string[]): Version {
    const t = this.getText(id);
    if (t.state === "approved") throw new TextApproved(id);
    if (t.state !== "in review") throw new NotYourTurn("amend the draft", t.state);
    if (t.waitsOn.some((w) => w.role === "reviewer" && w.actor !== "me")) throw new ReviewRunning(id);
    const current = this.getDraft(id);
    const all = current.content.split("\n");
    if (line < 1 || line > all.length) throw new RangeError(`line ${line} is outside 1..${all.length}`);
    all.splice(line - 1, 1, ...lines);
    const shift = lines.length - 1;
    const version = current.version + 1;
    return this.transaction(() => {
      const from = this.draftRowId(id, current.version);
      const to = this.insertDraft(id, version, "amended", all.join("\n"));
      this.db
        .prepare("UPDATE comment SET draft_id = ?, line = CASE WHEN line > ? THEN line + ? ELSE line END WHERE draft_id = ?")
        .run(to, line, shift, from);
      return version;
    });
  }

  /** A draft with its threads; the latest by default. */
  getDraft(id: TextId, version?: Version): Draft {
    const row = (
      version === undefined
        ? this.db.prepare("SELECT * FROM latest_draft WHERE text_id = ?").get(id)
        : this.db.prepare("SELECT * FROM draft WHERE text_id = ? AND version = ?").get(id, version)
    ) as { id: number; text_id: number; version: number; origin: Origin; content: string; created_at: string } | undefined;
    if (!row) throw new NotFound(version === undefined ? "draft of text" : `version ${version} of text`, id);
    const comments = this.db
      .prepare("SELECT id, author, parent_id, line, content, created_at FROM comment WHERE draft_id = ? ORDER BY id")
      .all(row.id) as unknown as { id: number; author: string; parent_id: number | null; line: number | null; content: string; created_at: string }[];
    const threads = new Map<number, Thread>();
    for (const c of comments) {
      const comment: Comment = { id: c.id, author: c.author, content: c.content, createdAt: c.created_at };
      if (c.parent_id === null) threads.set(c.id, { line: c.line, comments: [comment] });
      else threads.get(c.parent_id)?.comments.push(comment);
    }
    return {
      textId: row.text_id,
      version: row.version,
      origin: row.origin,
      content: row.content,
      createdAt: row.created_at,
      threads: [...threads.values()].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)),
    };
  }

  /** Deletes the text with its drafts, reviews and comments. */
  drop(id: TextId): void {
    const r = this.db.prepare("DELETE FROM text WHERE id = ?").run(id);
    if (r.changes === 0) throw new NotFound("text", id);
  }

  private insertDraft(textId: TextId, version: Version, origin: Origin, content: string): number {
    const r = this.db
      .prepare("INSERT INTO draft (text_id, version, origin, content) VALUES (?, ?, ?, ?)")
      .run(textId, version, origin, content);
    return Number(r.lastInsertRowid);
  }

  private draftRowId(textId: TextId, version: Version): number {
    const r = this.db.prepare("SELECT id FROM draft WHERE text_id = ? AND version = ?").get(textId, version) as { id: number };
    return r.id;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
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
