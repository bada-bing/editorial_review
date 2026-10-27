import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Core } from "./core.ts";
import { commitXml, templatesFor } from "./fixtures.ts";
import { openDatabase } from "./db.ts";
import { NotFound } from "./errors.ts";

const core = () => new Core(openDatabase(":memory:"), templatesFor);

describe("connections", () => {
  it("finds a connection again by its target", () => {
    const c = core();
    const id = c.connect("@12", "WFC-1145:edit");
    assert.equal(c.connect("@12", "renamed"), id);
    assert.notEqual(c.connect("@13", "10x_05:assistant"), id);
  });

  it("moves a connection to a window, absorbing the connection that window already had", () => {
    const c = core();
    const labelled = c.connect("@1", "WFC-1145:edit");
    const fresh = c.connect("@2", "WFC-1145:assistant");
    const text = c.openText({ connection: fresh }, "commit", { connection: fresh });
    c.reconnect(labelled, "@2");
    assert.deepEqual(c.getText(text).writer, { connection: labelled });
    assert.deepEqual(c.listConnections().map((x) => [x.id, x.target, x.label]), [[labelled, "@2", "WFC-1145:edit"]]);
  });
});

describe("texts", () => {
  it("opens a text that waits on its writer, keeping its context", () => {
    const c = core();
    const w = c.connect("@12", "WFC-1145:edit");
    const id = c.openText({ connection: w }, "commit", { connection: w }, { diff: "+a" });
    const t = c.getText(id);
    assert.equal(t.scenario, "commit");
    assert.deepEqual(t.context, { diff: "+a" });
    assert.deepEqual(t.writer, { connection: w });
    assert.equal(t.state, "drafting");
    assert.deepEqual(t.waitsOn, [{ actor: { connection: w }, role: "writer" }]);
  });

  it("opens a text with me as the writer, under an eight-character id", () => {
    const c = core();
    const id = c.openText("me", "slack", "me");
    assert.match(id, /^[0-9a-f]{8}$/);
    const t = c.getText(id);
    assert.equal(t.writer, "me");
    assert.deepEqual(t.waitsOn, [{ actor: "me", role: "writer" }]);
  });

  it("lists the open texts in the order they were opened", () => {
    const c = core();
    const a = c.openText("me", "commit", "me");
    const b = c.openText("me", "slack", "me");
    assert.deepEqual(c.listOpenTexts().map((t) => t.id), [a, b]);
  });

  it("drops a text, after which it is not found", () => {
    const c = core();
    const id = c.openText("me", "commit", "me");
    c.drop("me", id);
    assert.throws(() => c.getText(id), NotFound);
    assert.throws(() => c.drop("me", id), NotFound);
    assert.deepEqual(c.listOpenTexts(), []);
  });
});
