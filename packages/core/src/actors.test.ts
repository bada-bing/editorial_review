import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Core } from "./core.ts";
import { commitXml, structureFor } from "./fixtures.ts";
import { openDatabase } from "./db.ts";
import { Forbidden } from "./errors.ts";

const setup = () => {
  const core = new Core(openDatabase(":memory:"), structureFor);
  const writer = core.connect("@1", "WFC-1145:edit");
  const other = core.connect("@2", "reviewer:fable");
  const id = core.openText({ connection: writer }, "commit", { connection: writer });
  return { core, id, W: { connection: writer } as const, O: { connection: other } as const, other };
};

describe("the actor check", () => {
  it("refuses amending, requesting a review, approving and dropping to an agent", () => {
    const { core, id, W, O, other } = setup();
    core.submitDraft(W, id, commitXml("a", ["b"]));
    assert.throws(() => core.amendLine(W, id, core.getDraft(id).rows[0]!.id, ["b"]), Forbidden);
    assert.throws(() => core.requestReview(W, id, other), Forbidden);
    assert.throws(() => core.approve(O, id), Forbidden);
    assert.throws(() => core.drop(W, id), Forbidden);
    assert.equal(core.getText(id).state, "in review");
  });

  it("lets only the writer submit a draft", () => {
    const { core, id, O } = setup();
    assert.throws(() => core.submitDraft(O, id, commitXml("a", ["b"])), Forbidden);
    assert.throws(() => core.submitDraft("me", id, commitXml("a", ["b"])), Forbidden);
    const mine = core.openText("me", "commit", "me");
    assert.equal(core.submitDraft("me", mine, commitXml("a", ["b"])), 1);
  });

  it("lets a reviewer submit only its own review", () => {
    const { core, id, W, O, other } = setup();
    core.submitDraft(W, id, commitXml("a", ["b"]));
    core.requestReview("me", id, other);
    assert.throws(() => core.submitReview(W, id));
    core.submitReview(O, id);
    core.submitReview("me", id);
    assert.equal(core.getText(id).state, "drafting");
  });

  it("lets anyone open a text for any writer", () => {
    const { core, W, O } = setup();
    assert.equal(core.getText(core.openText(W, "commit", "me")).writer, "me");
    assert.deepEqual(core.getText(core.openText(W, "commit", O)).writer, O);
    assert.deepEqual(core.getText(core.openText("me", "commit", O)).writer, O);
  });

  it("lets anyone comment", () => {
    const { core, id, W, O } = setup();
    core.submitDraft(W, id, commitXml("a", ["b"]));
    const first = core.getDraft(id).rows[0]!.id;
    core.addComment("me", id, { author: "miki", content: "x", lineId: first });
    core.addComment(O, id, { author: "reviewer:fable", content: "y", lineId: first });
    core.addComment(W, id, { author: "writer", content: "z" });
    assert.equal(core.getDraft(id).threads.length, 3);
  });
});
