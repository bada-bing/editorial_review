import type { TextId } from "@editorial-review/core";

export type Event =
  | { event: "text"; data: { id: TextId; state: string; latestVersion: number | null } }
  | { event: "text"; data: { id: TextId; dropped: true } }
  | { event: "connections"; data: unknown[] };

type Listener = (e: Event) => void;

/**
 * What the page listens to: one event per change to a text, and one when a
 * participant's window changes state. The page refreshes what the event names
 * and never polls.
 */
export class Events {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(e: Event): void {
    for (const l of this.listeners) l(e);
  }

  get subscribers(): number {
    return this.listeners.size;
  }
}
