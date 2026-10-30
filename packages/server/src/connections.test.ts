import { Core, openDatabase } from "@editorial-review/core";
import { COMMIT_TEMPLATES, commitXml, structureFor } from "@editorial-review/core/fixtures";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Connections } from "./connections.ts";
import { fakeTmux } from "./tmux.fake.ts";

const setup = () => {
  const core = new Core(openDatabase(":memory:"), structureFor);
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
    assert.match(c.id, /^[0-9a-f]{8}$/);
    assert.deepEqual([c.target, c.label], ["@1", "WFC-1145:edit"]);
    assert.equal((await connections.fromPane("%1")).id, c.id);
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
    assert.deepEqual([c.target, c.label], ["@2", "reviewer:fable"]);
  });

  it("is taken over, with its texts, by a new window named as its label once it is gone", async () => {
    const { connections, core, tmux } = setup();
    const old = await connections.fromPane("%1");
    const text = core.openText({ connection: old.id }, "commit", { connection: old.id });
    tmux.panes["%1"]!.state = "gone";
    tmux.panes["%4"] = { id: "@4", name: "WFC-1145:edit" };
    const back = await connections.fromPane("%4");
    assert.equal(back.id, old.id);
    assert.deepEqual((await connections.list()).map((c) => [c.label, c.target]), [["WFC-1145:edit", "@4"]]);
    assert.deepEqual(core.getText(text).writer, { connection: old.id });
  });

  it("gives a second live window of the same name a label of its own", async () => {
    const { connections, tmux } = setup();
    await connections.fromPane("%1");
    tmux.panes["%4"] = { id: "@4", name: "WFC-1145:edit" };
    const second = await connections.fromPane("%4");
    assert.equal(second.label, `WFC-1145:edit#${second.id}`);
  });

  it("relabels the caller's own connection for a label nobody has, rather than adding one", async () => {
    const { connections } = setup();
    const own = await connections.fromPane("%2");
    const c = await connections.reconnectAs("editorial", "%2");
    assert.equal(c.id, own.id);
    assert.deepEqual((await connections.list()).map((x) => x.label), ["editorial"]);
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
