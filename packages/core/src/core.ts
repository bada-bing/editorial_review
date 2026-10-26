import type { DatabaseSync } from "node:sqlite";
import { Forbidden, Invalid, NotApproved, NotFound, NotYourTurn, ReviewRunning, TextApproved } from "./errors.ts";
import { toOutput } from "./output.ts";

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
  /** The comment this one answers; null for a thread's first comment. */
  parentId: number | null;
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

export interface Connection {
  id: ConnectionId;
  target: string;
  label: string;
}

export type ReviewId = number;
export type CommentId = number;

/** A new comment: on a line, on the whole draft, or a reply to any comment of the current draft. */
export interface NewComment {
  author: string;
  content: string;
  line?: number;
  replyTo?: CommentId;
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

const sameActor = (a: Actor, b: Actor): boolean =>
  a === "me" ? b === "me" : b !== "me" && a.connection === b.connection;

/**
 * Every rule of the record, over one open database. Only `server` holds one.
 *
 * Every action names its actor, me or a connection, and is checked before it
 * acts: amending, requesting a review, approving and dropping are mine, a
 * draft is the writer's, a review is its reviewer's. Anyone opens a text or
 * comments, and reading needs no actor.
 * Connections are established by `server` for whoever reaches it.
 */
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

  /**
   * Points a connection at another tmux window; it keeps its texts. A
   * connection the window already has is the same agent, so its texts and
   * reviews pass to this one and it is removed.
   */
  reconnect(id: ConnectionId, target: string): void {
    this.transaction(() => {
      const holder = this.findConnection({ target });
      if (holder && holder.id !== id) {
        this.db.prepare("UPDATE text SET writer_connection_id = ? WHERE writer_connection_id = ?").run(id, holder.id);
        this.db.prepare("UPDATE review SET reviewer_connection_id = ? WHERE reviewer_connection_id = ?").run(id, holder.id);
        this.db.prepare("DELETE FROM connection WHERE id = ?").run(holder.id);
      }
      const r = this.db.prepare("UPDATE connection SET target = ? WHERE id = ?").run(target, id);
      if (r.changes === 0) throw new NotFound("connection", id);
    });
  }

  relabel(id: ConnectionId, label: string): void {
    const r = this.db.prepare("UPDATE connection SET label = ? WHERE id = ?").run(label, id);
    if (r.changes === 0) throw new NotFound("connection", id);
  }

  findConnection(by: { target: string } | { label: string }): Connection | undefined {
    return (
      "target" in by
        ? this.db.prepare("SELECT id, target, label FROM connection WHERE target = ?").get(by.target)
        : this.db.prepare("SELECT id, target, label FROM connection WHERE label = ?").get(by.label)
    ) as Connection | undefined;
  }

  listConnections(): Connection[] {
    return this.db.prepare("SELECT id, target, label FROM connection ORDER BY id").all() as unknown as Connection[];
  }

  /** Opens a text for any writer; it waits on that writer for the first draft. */
  openText(actor: Actor, scenario: string, writer: Actor, context: Context = {}): TextId {
    void actor; // anyone opens a text, for themselves or for someone else
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
  submitDraft(actor: Actor, id: TextId, content: string): Version {
    const t = this.getText(id);
    if (!sameActor(actor, t.writer)) throw new Forbidden("submit a draft as its writer");
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
  amendDraft(actor: Actor, id: TextId, line: number, lines: string[]): Version {
    if (actor !== "me") throw new Forbidden("amend a draft");
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
    // A reply joins the thread of the comment it answers; a parent always
    // precedes its replies by id, so one pass resolves every thread.
    const threads = new Map<number, Thread>();
    const threadOf = new Map<number, number>();
    for (const c of comments) {
      const comment: Comment = { id: c.id, author: c.author, parentId: c.parent_id, content: c.content, createdAt: c.created_at };
      const root = c.parent_id === null ? c.id : threadOf.get(c.parent_id)!;
      threadOf.set(c.id, root);
      if (c.parent_id === null) threads.set(c.id, { line: c.line, comments: [comment] });
      else threads.get(root)!.comments.push(comment);
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

  /**
   * Adds a comment to the current draft. Only in review: a thread on a line or
   * on the whole draft, or a reply to a comment, which joins that comment's
   * thread. An Ask is answered the same way, by a reply.
   */
  addComment(actor: Actor, id: TextId, comment: NewComment): CommentId {
    void actor; // anyone in the conversation may comment; the author label says who
    const t = this.getText(id);
    if (t.state === "approved") throw new TextApproved(id);
    if (t.state !== "in review") throw new NotYourTurn("comment", t.state);
    if (comment.line !== undefined && comment.replyTo !== undefined) throw new Invalid("a comment is on a line or a reply, not both");
    const draftId = this.draftRowId(id, t.latestVersion!);
    if (comment.line !== undefined) {
      const lines = this.getDraft(id).content.split("\n").length;
      if (comment.line < 1 || comment.line > lines) throw new Invalid(`line ${comment.line} is outside 1..${lines}`);
    }
    if (comment.replyTo !== undefined) {
      const parent = this.db.prepare("SELECT 1 FROM comment WHERE id = ? AND draft_id = ?").get(comment.replyTo, draftId);
      if (!parent) throw new Invalid(`comment ${comment.replyTo} is not on the current draft`);
    }
    const r = this.db
      .prepare("INSERT INTO comment (draft_id, author, line, parent_id, content) VALUES (?, ?, ?, ?, ?)")
      .run(draftId, comment.author, comment.line ?? null, comment.replyTo ?? null, comment.content);
    return Number(r.lastInsertRowid);
  }

  /** Asks a connection to review the current draft; the text then waits on it too. Only in review. */
  requestReview(actor: Actor, id: TextId, reviewer: ConnectionId): ReviewId {
    if (actor !== "me") throw new Forbidden("request a review");
    const t = this.getText(id);
    if (t.state === "approved") throw new TextApproved(id);
    if (t.state !== "in review") throw new NotYourTurn("request a review", t.state);
    const draftId = this.draftRowId(id, t.latestVersion!);
    const existing = this.db
      .prepare("SELECT id FROM review WHERE draft_id = ? AND reviewer_connection_id = ?")
      .get(draftId, reviewer) as { id: number } | undefined;
    if (existing) return existing.id;
    const r = this.db.prepare("INSERT INTO review (draft_id, reviewer_connection_id) VALUES (?, ?)").run(draftId, reviewer);
    return Number(r.lastInsertRowid);
  }

  /**
   * Ends the actor's review of the current draft. Mine is recorded by this
   * call; a connection's must have been requested. Once no review is open and
   * mine is submitted, the text is drafting again.
   */
  submitReview(actor: Actor, id: TextId): void {
    const reviewer = actor;
    const t = this.getText(id);
    if (t.state === "approved") throw new TextApproved(id);
    if (t.state !== "in review") throw new NotYourTurn("submit a review", t.state);
    const draftId = this.draftRowId(id, t.latestVersion!);
    if (reviewer === "me") {
      const done = this.db
        .prepare("SELECT 1 FROM review WHERE draft_id = ? AND reviewer_connection_id IS NULL")
        .get(draftId);
      if (done) throw new NotYourTurn("submit my review again", "waiting on a requested reviewer");
      this.db.prepare("INSERT INTO review (draft_id, submitted_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))").run(draftId);
      return;
    }
    const r = this.db
      .prepare("UPDATE review SET submitted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE draft_id = ? AND reviewer_connection_id = ? AND submitted_at IS NULL")
      .run(draftId, reviewer.connection);
    if (r.changes === 0) throw new NotFound("open review of the current draft by connection", reviewer.connection);
  }

  /**
   * Approves the current draft, submitted or amended. Only in review, and not
   * while a requested review runs, since its comments would go unread. The
   * text then accepts no further change.
   */
  approve(actor: Actor, id: TextId): void {
    if (actor !== "me") throw new Forbidden("approve a text");
    const t = this.getText(id);
    if (t.state === "approved") throw new TextApproved(id);
    if (t.state !== "in review") throw new NotYourTurn("approve", t.state);
    if (t.waitsOn.some((w) => w.role === "reviewer" && w.actor !== "me")) throw new ReviewRunning(id);
    const draftId = this.draftRowId(id, t.latestVersion!);
    this.db.prepare("UPDATE text SET approved_draft_id = ? WHERE id = ?").run(draftId, id);
  }

  /** The approved draft in output form. Fails unless the text is approved. */
  getResult(id: TextId): string {
    const t = this.getText(id);
    if (t.state !== "approved") throw new NotApproved(id, t.state);
    const row = this.db
      .prepare("SELECT d.content FROM text t JOIN draft d ON d.id = t.approved_draft_id WHERE t.id = ?")
      .get(id) as { content: string };
    return toOutput(row.content);
  }

  /** Deletes the text with its drafts, reviews and comments. */
  drop(actor: Actor, id: TextId): void {
    if (actor !== "me") throw new Forbidden("drop a text");
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
