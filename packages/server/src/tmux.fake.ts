import type { Tmux, Window, WindowState } from "./tmux.ts";

export interface FakeWindow extends Window {
  state?: WindowState;
}

/** A tmux of panes in windows, for tests. Every window runs an agent unless its state is gone. */
export function fakeTmux(panes: Record<string, FakeWindow>): Tmux & { panes: Record<string, FakeWindow> } {
  const windows = () => Object.values(panes);
  return {
    panes,
    async windowOfPane(pane) {
      const w = panes[pane];
      return w ? { id: w.id, name: w.name } : undefined;
    },
    async windowState(windowId) {
      const w = windows().find((w) => w.id === windowId);
      if (!w || w.state === "gone") return { state: "gone" };
      return { state: w.state ?? "idle", name: w.name };
    },
    async agentWindows() {
      return windows().filter((w) => w.state !== "gone").map(({ id, name }) => ({ id, name }));
    },
  };
}
