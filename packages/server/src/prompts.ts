import type { ConnectionId, Core, TextId } from "@editorial-review/core";
import type { Tmux } from "./tmux.ts";

export type PromptKind = "draft" | "redraft" | "ask" | "review" | "result" | "dropped";

export interface Prompt {
  connection: ConnectionId;
  text: TextId;
  kind: PromptKind;
  line: string;
}

/**
 * Every instruction an agent receives is a prompt typed into its window. A
 * prompt waits while the window is busy, since typing into a working agent
 * lands in its input, and while it is gone, until the connection is
 * re-established; the action that caused it never waits.
 */
export class Prompts {
  private readonly core: Core;
  private readonly tmux: Tmux;
  private readonly specPath: (scenario: string) => string;
  private readonly queues = new Map<ConnectionId, Prompt[]>();
  private timer: NodeJS.Timeout | undefined;

  constructor(core: Core, tmux: Tmux, specPath: (scenario: string) => string) {
    this.core = core;
    this.tmux = tmux;
    this.specPath = specPath;
  }

  /** Delivers what is pending every `ms`, until stopped. */
  start(ms = 2000): void {
    this.timer = setInterval(() => void this.deliver(), ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  pending(connection: ConnectionId): number {
    return this.queues.get(connection)?.length ?? 0;
  }

  /** Types the head of every queue whose window can take it. */
  async deliver(): Promise<void> {
    for (const [connection, queue] of this.queues) {
      const head = queue[0];
      if (!head) continue;
      const target = this.core.listConnections().find((c) => c.id === connection)?.target;
      if (!target) {
        this.queues.delete(connection);
        continue;
      }
      const { state } = await this.tmux.windowState(target);
      if (state !== "waiting" && state !== "idle") continue;
      queue.shift();
      // A prompt queued while the window was busy may be stale by the time
      // the window is free: the writer drafted before being told to. One
      // whose occasion has passed is dropped rather than typed.
      if (this.stale(head)) continue;
      await this.tmux.type(target, head.line);
    }
  }

  private stale(p: Prompt): boolean {
    let t;
    try {
      t = this.core.getText(p.text);
    } catch {
      return p.kind !== "dropped";
    }
    switch (p.kind) {
      case "draft":
      case "redraft":
        return t.state !== "drafting";
      case "review":
        return !t.waitsOn.some((w) => w.role === "reviewer" && w.actor !== "me" && w.actor.connection === p.connection);
      case "ask":
        return t.state !== "in review";
      case "result":
        return t.state !== "approved";
      case "dropped":
        return false;
    }
  }

  /** What a restart loses: the prompts for every text still waiting on an agent. */
  rederive(): void {
    for (const t of this.core.listOpenTexts()) {
      for (const w of t.waitsOn) {
        if (w.actor === "me") continue;
        if (w.role === "writer") this.queue(w.actor.connection, t.id, t.latestVersion === null ? "draft" : "redraft");
        else this.queue(w.actor.connection, t.id, "review");
      }
    }
  }

  draft(text: TextId): void {
    const t = this.core.getText(text);
    if (t.writer !== "me") this.queue(t.writer.connection, text, "draft");
  }

  /** After a review: the writer drafts again, if the text is drafting. */
  redraft(text: TextId): void {
    const t = this.core.getText(text);
    if (t.state === "drafting" && t.writer !== "me") this.queue(t.writer.connection, text, "redraft");
  }

  ask(text: TextId, commentId: string): void {
    const t = this.core.getText(text);
    if (t.writer === "me") return;
    const draft = this.core.getDraft(text);
    const thread = draft.threads.find((th) => th.comments.some((c) => c.id === commentId));
    const comment = thread?.comments.find((c) => c.id === commentId);
    if (!thread || !comment) return;
    const where = thread.lineId === null ? "on the whole draft" : `on line ${thread.lineId}`;
    this.queue(t.writer.connection, text, "ask", `Question ${where} of text ${text}, comment ${commentId}: ${oneLine(comment.content)} Answer with: editorial add-comment ${text} --author writer --reply-to ${commentId} < answer`);
  }

  review(text: TextId, reviewer: ConnectionId): void {
    this.queue(reviewer, text, "review");
  }

  result(text: TextId): void {
    const t = this.core.getText(text);
    if (t.writer !== "me") this.queue(t.writer.connection, text, "result");
  }

  /** Called before the drop, while the text still says who it waits on. Whatever was still queued for the text goes. */
  dropped(text: TextId): void {
    for (const [connection, queue] of this.queues) this.queues.set(connection, queue.filter((p) => p.text !== text));
    const t = this.core.getText(text);
    const told = new Set<ConnectionId>();
    for (const actor of [t.writer, ...t.waitsOn.map((w) => w.actor)]) {
      if (actor === "me" || told.has(actor.connection)) continue;
      told.add(actor.connection);
      this.queue(actor.connection, text, "dropped");
    }
  }

  private queue(connection: ConnectionId, text: TextId, kind: PromptKind, line?: string): void {
    line ??= this.wording(kind as Exclude<PromptKind, "ask">, text);
    const queue = this.queues.get(connection) ?? [];
    // One pending instruction per text and kind; an Ask is its own each time.
    if (kind !== "ask" && queue.some((p) => p.text === text && p.kind === kind)) return;
    queue.push({ connection, text, kind, line });
    this.queues.set(connection, queue);
  }

  private wording(kind: Exclude<PromptKind, "ask">, text: TextId): string {
    const t = this.core.getText(text);
    const spec = this.specPath(t.scenario);
    switch (kind) {
      case "draft":
        return `Text ${text} of the ${t.scenario} scenario is open for you to write. Read its spec at ${spec}, the Structure section above all, and the context with: editorial get-text ${text}. Draft it as XML matching the templates, one <line> per sentence-like unit, as message.example.xml beside the spec shows, and submit with: editorial submit-draft ${text} < draft.xml`;
      case "redraft":
        return `Text ${text} was reviewed. Read the draft with its line ids and comments with: editorial get-draft ${text} --xml. Start from that XML, keep the id of every line you leave alone or rewrite, set answers="<comment ids>" on a line you change for a comment, change only what the comments ask for, and submit the next version with: editorial submit-draft ${text} < draft.xml`;
      case "review":
        return `Review text ${text} of the ${t.scenario} scenario against its spec at ${spec}. Read the draft with: editorial get-draft ${text}. Comment on a line by its id with: editorial add-comment ${text} --line <id> < comment. When done: editorial submit-review ${text}`;
      case "result":
        return `Text ${text} is approved. Take it with: editorial get-result ${text}, and use it for what it was opened for.`;
      case "dropped":
        return `Text ${text} was dropped. Nothing more to do with it.`;
    }
  }
}

function oneLine(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, " / ");
}
