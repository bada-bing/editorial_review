import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** What a connection's window is doing, as the status bar marks it. */
export type WindowState = "busy" | "waiting" | "idle" | "gone";

export interface Window {
  /** tmux's window id, such as @12; fixed while the window lives. */
  id: string;
  /** session:window, as tmux names it. */
  name: string;
}

/** The part of tmux that connections need; a fake stands in for tests. */
export interface Tmux {
  /** The window holding a pane, or undefined when the pane is gone. */
  windowOfPane(pane: string): Promise<Window | undefined>;
  /** A window's state: gone when it no longer exists or no agent runs in it. */
  windowState(windowId: string): Promise<{ state: WindowState; name?: string }>;
  /** Every window in which an agent runs. */
  agentWindows(): Promise<Window[]>;
}

/** tmux as it is, with `agents` the commands that count as an agent running in a pane. */
export const realTmux = (agents: string[]): Tmux => ({
  async windowOfPane(pane) {
    try {
      const { stdout } = await run("tmux", ["display-message", "-p", "-t", pane, "#{window_id}\t#{session_name}:#{window_name}"]);
      const [id, name] = stdout.trimEnd().split("\t");
      return id && name && !name.startsWith(":") ? { id, name } : undefined;
    } catch {
      return undefined;
    }
  },

  async windowState(windowId) {
    try {
      const format = "#{pane_current_command}\t#{@window_state}\t#{session_name}:#{window_name}";
      const { stdout } = await run("tmux", ["display-message", "-p", "-t", windowId, format]);
      const [command, state, name] = stdout.trimEnd().split("\t");
      if (!name || name.startsWith(":")) return { state: "gone" };
      if (!agents.includes(command ?? "")) return { state: "gone", name };
      return { state: state === "busy" || state === "waiting" ? state : "idle", name };
    } catch {
      return { state: "gone" };
    }
  },

  async agentWindows() {
    try {
      const { stdout } = await run("tmux", ["list-panes", "-a", "-F", "#{window_id}\t#{session_name}:#{window_name}\t#{pane_current_command}"]);
      const seen = new Set<string>();
      const windows: Window[] = [];
      for (const line of stdout.trimEnd().split("\n")) {
        const [id, name, command] = line.split("\t");
        if (command && agents.includes(command) && id && name && !seen.has(id)) {
          seen.add(id);
          windows.push({ id, name });
        }
      }
      return windows;
    } catch {
      return [];
    }
  },
});
