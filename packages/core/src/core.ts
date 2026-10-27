import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { Forbidden, Invalid, NotApproved, NotFound, NotYourTurn, ReviewRunning, TextApproved } from "./errors.ts";
import type { Templates } from "./template.ts";
import { type Change, type Node, type Row, assignIds, check, compare, findLine, newLineId, outputLines, parseXml, render, rows, toXml, treeFromText } from "./tree.ts";

/** Eight hex characters, drawn at random, never reused. */
export type ConnectionId = string;
export type TextId = string;
export type CommentId = string;

export const newId = (): string => randomBytes(4).toString("hex");
/** An actor is me or a connection. In the database, NULL is me. */
export type Actor = "me" | { connection: ConnectionId };
export type State = "drafting" | "in review" | "approved";
/** A scenario's context items, by name: diff, log, intent. */
export type Context = Record<string, string>;

export type Version = number;
export type Origin = "submitted" | "amended";

export interface Comment {
  id: CommentId;
  author: string;
  /** The comment this one answers; null for a thread's first comment. */
  parentId: CommentId | null;
  content: string;
  createdAt: string;
}

/** A thread on one line, by the line's id, or on the whole draft when `lineId` is null. */
export interface Thread {
  lineId: string | null;
  comments: Comment[];
}

export interface Draft {
  textId: TextId;
  version: Version;
  origin: Origin;
  /** The tree as XML, every line carrying its id. */
  xml: string;
  /** The review view: one row per line, each with how it changed since the version before and the output line it becomes. */
  rows: (Row & { change: Change; output: string })[];
  /** The comments the rows' `answers` name, by id, so the page can show what was answered. */
  answered: Record<string, { author: string; content: string }>;
  /** Lines of the version before that this version no longer has. */
  removed: Row[];
  createdAt: string;
  threads: Thread[];
}

export interface Connection {
  id: ConnectionId;
  target: string;
  label: string;
}

export type ReviewId = number;

/** A new comment: on a line by its id, on the whole draft, or a reply to any comment of the current draft. */
export interface NewComment {
  author: string;
  content: string;
  lineId?: string;
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

const toActor = (connectionId: string | null): Actor =>
  connectionId === null ? "me" : { connection: connectionId };
const toColumn = (actor: Actor): string | null => (actor === "me" ? null : actor.connection);

interface StateRow {
  text_id: string;
  scenario: string;
  context: string;
  writer_connection_id: string | null;
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
  private readonly templatesFor: (scenario: string) => Templates;
  /** `templatesFor` gives a scenario's structure, read from its spec by `server`. */
  constructor(db: DatabaseSync, templatesFor: (scenario: string) => Templates) {
    this.db = db;
    this.templatesFor = templatesFor;
  }

  /** The connection for a tmux window, found by its target or created. */
  connect(target: string, label: string): ConnectionId {
    const found = this.db.prepare("SELECT id FROM connection WHERE target = ?").get(target) as
      | { id: string }
      | undefined;
    if (found) return found.id;
    const id = newId();
    this.db.prepare("INSERT INTO connection (id, target, label) VALUES (?, ?, ?)").run(id, target, label);
    return id;
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
    return this.db.prepare("SELECT id, target, label FROM connection ORDER BY rowid").all() as unknown as Connection[];
  }

  /** Opens a text for any writer; it waits on that writer for the first draft. */
  openText(actor: Actor, scenario: string, writer: Actor, context: Context = {}): TextId {
    void actor; // anyone opens a text, for themselves or for someone else
    const id = newId();
    this.db
      .prepare("INSERT INTO text (id, scenario, writer_connection_id, context) VALUES (?, ?, ?, ?)")
      .run(id, scenario, toColumn(writer), JSON.stringify(context));
    return id;
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
        "SELECT s.*, t.context, t.opened_at FROM text_state s JOIN text t ON t.id = s.text_id WHERE s.state <> 'approved' ORDER BY t.opened_at, t.rowid",
      )
      .all() as unknown as StateRow[];
    return rows.map((r) => this.toState(r));
  }

  /**
   * Saves the writer's next version, a tree as XML matching the scenario's
   * templates; every line gets an id it did not have. Only while drafting;
   * the text is then in review and waits on me, until I submit my review.
   */
  submitDraft(actor: Actor, id: TextId, xml: string): Version {
    const t = this.getText(id);
    if (!sameActor(actor, t.writer)) throw new Forbidden("submit a draft as its writer");
    if (t.state === "approved") throw new TextApproved(id);
    if (t.state !== "drafting") throw new NotYourTurn("submit a draft", t.state);
    const templates = this.templatesFor(t.scenario);
    const tree = assignIds(this.parseAndCheck(xml, templates));
    this.checkAnswers(id, tree);
    const version = (t.latestVersion ?? 0) + 1;
    this.insertDraft(id, version, "submitted", toXml(tree));
    return version;
  }

  /** Typed text as a draft of this text's scenario, built by its templates: what the page submits. */
  draftFromText(id: TextId, text: string): string {
    const t = this.getText(id);
    const templates = this.templatesFor(t.scenario);
    const tree = treeFromText(text, templates);
    // Lines that read the same as in the current version keep its ids, so a thread follows a line I retype unchanged.
    if (t.latestVersion !== null) {
      const known = new Map(rows(parseXml(this.getDraft(id).xml)).map((r) => [r.text, r.id]));
      const used = new Set<string>();
      const walk = (n: Node) => {
        if (n.name === "line") {
          const keep = known.get(n.text ?? "");
          if (keep && !used.has(keep)) {
            n.attrs["id"] = keep;
            used.add(keep);
          }
        }
        n.children.forEach(walk);
      };
      walk(tree);
    }
    return toXml(tree);
  }

  /**
   * Replaces the line with `lineId` by `lines`, as a new amended version: the
   * first keeps the id, the others are new, none removes the line. Only in
   * review, and only while no requested review is running. Threads stay on
   * their ids, so nothing moves.
   */
  amendLine(actor: Actor, id: TextId, lineId: string, lines: string[]): Version {
    if (actor !== "me") throw new Forbidden("amend a draft");
    const t = this.getText(id);
    if (t.state === "approved") throw new TextApproved(id);
    if (t.state !== "in review") throw new NotYourTurn("amend the draft", t.state);
    if (t.waitsOn.some((w) => w.role === "reviewer" && w.actor !== "me")) throw new ReviewRunning(id);
    const current = this.getDraft(id);
    const tree = parseXml(current.xml);
    const found = findLine(tree, lineId);
    if (!found) throw new NotFound("line of the current draft", lineId);
    const replacements: Node[] = lines.map((text, i) => ({ name: "line", attrs: i === 0 ? { id: lineId } : { id: newLineId() }, children: [], text: text.trim() }));
    found.parent.children.splice(found.index, 1, ...replacements);
    const templates = this.templatesFor(t.scenario);
    try {
      check(tree, templates);
    } catch (e) {
      throw new Invalid((e as Error).message);
    }
    const version = current.version + 1;
    return this.transaction(() => {
      const from = this.draftRowId(id, current.version);
      const to = this.insertDraft(id, version, "amended", toXml(tree));
      // The threads come along: they point at line ids, which the amend keeps.
      this.db.prepare("UPDATE comment SET draft_id = ? WHERE draft_id = ?").run(to, from);
      return version;
    });
  }

  /** Every draft of a text, oldest first, without content or threads. */
  listDrafts(id: TextId): { version: Version; origin: Origin; createdAt: string }[] {
    this.getText(id);
    return (
      this.db.prepare("SELECT version, origin, created_at FROM draft WHERE text_id = ? ORDER BY version").all(id) as unknown as {
        version: number;
        origin: Origin;
        created_at: string;
      }[]
    ).map((r) => ({ version: r.version, origin: r.origin, createdAt: r.created_at }));
  }

  /** A draft with its rows, compared with the version before, and its threads; the latest by default. */
  getDraft(id: TextId, version?: Version): Draft {
    const row = (
      version === undefined
        ? this.db.prepare("SELECT * FROM latest_draft WHERE text_id = ?").get(id)
        : this.db.prepare("SELECT * FROM draft WHERE text_id = ? AND version = ?").get(id, version)
    ) as { id: number; text_id: string; version: number; origin: Origin; content: string; created_at: string } | undefined;
    if (!row) throw new NotFound(version === undefined ? "draft of text" : `version ${version} of text`, id);
    const previous = this.db.prepare("SELECT content FROM draft WHERE text_id = ? AND version = ?").get(id, row.version - 1) as { content: string } | undefined;
    const tree = parseXml(row.content);
    const compared = compare(previous ? parseXml(previous.content) : undefined, tree);
    const output = new Map<string, string[]>();
    for (const l of outputLines(tree, this.templatesFor(this.getText(id).scenario))) {
      if (l.lineId) output.set(l.lineId, [...(output.get(l.lineId) ?? []), l.text]);
    }
    const answered: Draft["answered"] = {};
    const known = new Map(this.commentsOf(id).map((c) => [c.id, c]));
    for (const r of compared.rows) for (const a of r.answers) if (known.has(a)) answered[a] = { author: known.get(a)!.author, content: known.get(a)!.content };
    const comments = this.db
      .prepare("SELECT id, author, parent_id, line_id, content, created_at FROM comment WHERE draft_id = ? ORDER BY rowid")
      .all(row.id) as unknown as { id: string; author: string; parent_id: string | null; line_id: string | null; content: string; created_at: string }[];
    // A reply joins the thread of the comment it answers; a parent always
    // precedes its replies in creation order, so one pass resolves every thread.
    const threads = new Map<string, Thread>();
    const threadOf = new Map<string, string>();
    for (const c of comments) {
      const comment: Comment = { id: c.id, author: c.author, parentId: c.parent_id, content: c.content, createdAt: c.created_at };
      const root = c.parent_id === null ? c.id : threadOf.get(c.parent_id)!;
      threadOf.set(c.id, root);
      if (c.parent_id === null) threads.set(c.id, { lineId: c.line_id, comments: [comment] });
      else threads.get(root)!.comments.push(comment);
    }
    const order = new Map(compared.rows.map((r) => [r.id, r.n]));
    return {
      textId: row.text_id,
      version: row.version,
      origin: row.origin,
      xml: row.content,
      rows: compared.rows.map((r) => ({ ...r, output: (output.get(r.id) ?? [r.text]).join("\n") })),
      answered,
      removed: compared.removed,
      createdAt: row.created_at,
      threads: [...threads.values()].sort((a, b) => (a.lineId === null ? 0 : (order.get(a.lineId) ?? Infinity)) - (b.lineId === null ? 0 : (order.get(b.lineId) ?? Infinity))),
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
    if (comment.lineId !== undefined && comment.replyTo !== undefined) throw new Invalid("a comment is on a line or a reply, not both");
    const draftId = this.draftRowId(id, t.latestVersion!);
    if (comment.lineId !== undefined) {
      if (!this.getDraft(id).rows.some((r) => r.id === comment.lineId)) throw new Invalid(`line ${comment.lineId} is not in the current draft`);
    }
    if (comment.replyTo !== undefined) {
      const parent = this.db.prepare("SELECT 1 FROM comment WHERE id = ? AND draft_id = ?").get(comment.replyTo, draftId);
      if (!parent) throw new Invalid(`comment ${comment.replyTo} is not on the current draft`);
    }
    const commentId = newId();
    this.db
      .prepare("INSERT INTO comment (id, draft_id, author, line_id, parent_id, content) VALUES (?, ?, ?, ?, ?, ?)")
      .run(commentId, draftId, comment.author, comment.lineId ?? null, comment.replyTo ?? null, comment.content);
    return commentId;
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

  /** The approved draft as its destination takes it, rendered by the scenario's templates. Fails unless the text is approved. */
  getResult(id: TextId): string {
    const t = this.getText(id);
    if (t.state !== "approved") throw new NotApproved(id, t.state);
    const row = this.db
      .prepare("SELECT d.content FROM text t JOIN draft d ON d.id = t.approved_draft_id WHERE t.id = ?")
      .get(id) as { content: string };
    return render(parseXml(row.content), this.templatesFor(t.scenario));
  }

  /** Any draft rendered as the output would be: the page's preview. */
  renderDraft(id: TextId, version?: Version): string {
    const t = this.getText(id);
    return render(parseXml(this.getDraft(id, version).xml), this.templatesFor(t.scenario));
  }

  /** Every `answers` on a line names a comment of this text. */
  private checkAnswers(id: TextId, tree: Node): void {
    const known = new Set(this.commentsOf(id).map((c) => c.id));
    for (const r of rows(tree)) {
      for (const a of r.answers) if (!known.has(a)) throw new Invalid(`line ${r.id} answers ${a}, which is not a comment of this text`);
    }
  }

  private commentsOf(id: TextId): { id: string; author: string; content: string }[] {
    return this.db
      .prepare("SELECT c.id, c.author, c.content FROM comment c JOIN draft d ON d.id = c.draft_id WHERE d.text_id = ?")
      .all(id) as unknown as { id: string; author: string; content: string }[];
  }

  private parseAndCheck(xml: string, templates: Templates): Node {
    try {
      const tree = parseXml(xml);
      check(tree, templates);
      return tree;
    } catch (e) {
      throw new Invalid((e as Error).message);
    }
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
      .all(row.text_id) as unknown as { connection_id: string | null; role: "writer" | "reviewer" }[];
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
