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
 * by id; its label defaults to the window's name.
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
    return this.core.findConnection({ target: window.id }) ?? this.create(window);
  }

  /** The connection for a window picked in the UI, created if it has none. */
  forWindow(window: Window): Connection {
    return this.core.findConnection({ target: window.id }) ?? this.create(window);
  }

  /**
   * `editorial connect --as <label>`: the connection with that label now
   * targets the caller's window, keeping its texts. With no such label, a
   * new connection with it.
   */
  async reconnectAs(label: string, pane: string): Promise<Connection> {
    const window = await this.tmux.windowOfPane(pane);
    if (!window) throw new CoreError("Invalid", `pane ${pane} is not a tmux pane`);
    const existing = this.core.findConnection({ label });
    if (!existing) return this.create(window, label);
    this.core.reconnect(existing.id, window.id);
    return { ...existing, target: window.id };
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

  /** Windows running an agent that are not yet connections: the candidates for a reviewer. */
  async candidateWindows(): Promise<Window[]> {
    const taken = new Set(this.core.listConnections().map((c) => c.target));
    return (await this.tmux.agentWindows()).filter((w) => !taken.has(w.id));
  }

  private create(window: Window, label = window.name): Connection {
    const id = this.core.connect(window.id, label);
    return { id, target: window.id, label };
  }
}
