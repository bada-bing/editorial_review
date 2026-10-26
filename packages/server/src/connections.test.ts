import { Core, openDatabase } from "@editorial-review/core";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Connections } from "./connections.ts";
import { fakeTmux } from "./tmux.fake.ts";

const setup = () => {
  const core = new Core(openDatabase(":memory:"));
  const tmux = fakeTmux({
    "%1": { id: "@1", name: "WFC-1145:edit", state: "busy" },
    "%2": { id: "@2", name: "10x_05:assistant" },
    "%3": { id: "@3", name: "default:shell", state: "gone" },
  });
  return { core, tmux, connections: new Connections(core, tmux) };
};

describe("connections", () => {
  it("is established by a pane's first request, for the pane's window, labelled by the window's name", async () => {
    const { connections } = setup();
    const c = await connections.fromPane("%1");
    assert.deepEqual(c, { id: 1, target: "@1", label: "WFC-1145:edit" });
    assert.equal((await connections.fromPane("%1")).id, 1);
  });

  it("reports each connection's state from its window", async () => {
    const { connections, core } = setup();
    await connections.fromPane("%1");
    await connections.fromPane("%2");
    core.connect("@9", "old:window");
    assert.deepEqual((await connections.list()).map((c) => [c.label, c.state]), [
      ["WFC-1145:edit", "busy"],
      ["10x_05:assistant", "idle"],
      ["old:window", "gone"],
    ]);
  });

  it("is re-established by label from another pane, keeping its texts", async () => {
    const { connections, core, tmux } = setup();
    const c = await connections.fromPane("%1");
    const text = core.openText({ connection: c.id }, "commit", { connection: c.id });
    tmux.panes["%1"]!.state = "gone";
    const again = await connections.reconnectAs("WFC-1145:edit", "%2");
    assert.equal(again.id, c.id);
    assert.equal(again.target, "@2");
    assert.deepEqual(core.getText(text).writer, { connection: c.id });
    assert.equal((await connections.list())[0]!.state, "idle");
  });

  it("creates a connection for an unknown label", async () => {
    const { connections } = setup();
    const c = await connections.reconnectAs("reviewer:fable", "%2");
    assert.deepEqual(c, { id: 1, target: "@2", label: "reviewer:fable" });
  });

  it("offers the agent windows that are not yet connections", async () => {
    const { connections } = setup();
    await connections.fromPane("%1");
    assert.deepEqual(await connections.candidateWindows(), [{ id: "@2", name: "10x_05:assistant" }]);
  });

  it("refuses a pane tmux does not know", async () => {
    const { connections } = setup();
    await assert.rejects(connections.fromPane("%7"));
  });
});
