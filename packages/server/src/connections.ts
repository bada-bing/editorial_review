import { CoreError, type Connection, type ConnectionId, type Core } from "@editorial-review/core";
import type { Tmux, Window, WindowState } from "./tmux.ts";

export interface ConnectionWithState extends Connection {
  state: WindowState;
  /** The window's current name, when it still exists. */
  window?: string;
}

/**
 * Connections are standing links to agents in tmux windows. One is established
 * implicitly, by the first request from a pane, and targets the pane's window
 * by id; its label defaults to the window's name, and a label is unique. A
 * window named as a gone connection's label is that agent back, and takes the
 * connection over with its texts.
 */
export class Connections {
  private readonly core: Core;
  readonly tmux: Tmux;
  constructor(core: Core, tmux: Tmux) {
    this.core = core;
    this.tmux = tmux;
  }

  /** The connection of the window holding `pane`, created if the window has none. */
  async fromPane(pane: string): Promise<Connection> {
    const window = await this.tmux.windowOfPane(pane);
    if (!window) throw new CoreError("Invalid", `pane ${pane} is not a tmux pane`);
    return this.core.findConnection({ target: window.id }) ?? (await this.create(window));
  }

  /** The connection for a window picked in the UI, created if it has none. */
  async forWindow(window: Window): Promise<Connection> {
    return this.core.findConnection({ target: window.id }) ?? (await this.create(window));
  }

  /**
   * `editorial connect --as <label>`: the connection with that label now
   * targets the caller's window, keeping its texts. With no such label, the
   * caller's window takes it: its connection is relabelled, or one is created.
   */
  async reconnectAs(label: string, pane: string): Promise<Connection> {
    const window = await this.tmux.windowOfPane(pane);
    if (!window) throw new CoreError("Invalid", `pane ${pane} is not a tmux pane`);
    const existing = this.core.findConnection({ label });
    if (existing) {
      this.core.reconnect(existing.id, window.id);
      return { ...existing, target: window.id };
    }
    const own = this.core.findConnection({ target: window.id });
    if (!own) return this.create(window, label);
    this.core.relabel(own.id, label);
    return { ...own, label };
  }

  /** From the UI: a gone connection re-established on another window. */
  retarget(id: ConnectionId, windowId: string): void {
    this.core.reconnect(id, windowId);
  }

  relabel(id: ConnectionId, label: string): void {
    this.core.relabel(id, label);
  }

  async list(): Promise<ConnectionWithState[]> {
    return Promise.all(
      this.core.listConnections().map(async (c) => {
        const { state, name } = await this.tmux.windowState(c.target);
        return { ...c, state, ...(name ? { window: name } : {}) };
      }),
    );
  }

  /**
   * Reads every connection's state every `ms` and calls `onChange` with the
   * list whenever one differs from the last reading.
   */
  watch(onChange: (list: ConnectionWithState[]) => void, ms = 2000): () => void {
    let last = "";
    const tick = async () => {
      const list = await this.list();
      const now = JSON.stringify(list.map((c) => [c.id, c.state, c.target, c.label]));
      if (now !== last) {
        last = now;
        onChange(list);
      }
    };
    const timer = setInterval(() => void tick(), ms);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Windows running an agent that are not yet connections: the candidates for a reviewer. */
  async candidateWindows(): Promise<Window[]> {
    const taken = new Set(this.core.listConnections().map((c) => c.target));
    return (await this.tmux.agentWindows()).filter((w) => !taken.has(w.id));
  }

  private async create(window: Window, label = window.name): Promise<Connection> {
    const holder = this.core.findConnection({ label });
    if (holder && (await this.tmux.windowState(holder.target)).state === "gone") {
      this.core.reconnect(holder.id, window.id);
      return { ...holder, target: window.id };
    }
    const id = this.core.connect(window.id, label);
    return this.core.findConnection({ target: window.id }) ?? { id, target: window.id, label };
  }
}
