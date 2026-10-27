import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Core } from "./core.ts";
import { commitXml, templatesFor } from "./fixtures.ts";
import { openDatabase } from "./db.ts";
import { Invalid, NotFound, NotYourTurn } from "./errors.ts";

const setup = () => {
  const core = new Core(openDatabase(":memory:"), templatesFor);
  const writer = core.connect("@1", "WFC-1145:edit");
  const reviewer = core.connect("@2", "reviewer:fable");
  const id = core.openText({ connection: writer }, "commit", { connection: writer });
  core.submitDraft({ connection: writer }, id, commitXml("one", ["two", "three"]));
  const [one, two, three] = core.getDraft(id).rows.map((r) => r.id);
  return { core, id, writer, reviewer, one: one!, two: two!, three: three! };
};

describe("addComment", () => {
  it("starts a thread on a line or on the whole draft, and a reply joins the thread of the comment it answers", () => {
    const { core, id, writer, two } = setup();
    const first = core.addComment("me", id, { author: "miki", content: "shorter", lineId: two });
    core.addComment("me", id, { author: "miki", content: "too long overall" });
    const answer = core.addComment({ connection: writer }, id, { author: "writer", content: "like this?", replyTo: first });
    core.addComment("me", id, { author: "miki", content: "yes", replyTo: answer });
    const threads = core.getDraft(id).threads;
    assert.deepEqual(threads.map((t) => [t.lineId, t.comments.map((c) => [c.author, c.parentId])]), [
      [null, [["miki", null]]],
      [two, [["miki", null], ["writer", first], ["miki", answer]]],
    ]);
  });

  it("refuses a line outside the draft, a reply to a comment of another draft, and both at once", () => {
    const { core, id, writer, one } = setup();
    const first = core.addComment("me", id, { author: "miki", content: "a", lineId: one });
    assert.throws(() => core.addComment("me", id, { author: "miki", content: "c", lineId: "00000000" }), Invalid);
    assert.throws(() => core.addComment("me", id, { author: "miki", content: "c", lineId: one, replyTo: first }), Invalid);
    core.submitReview("me", id);
    core.submitDraft({ connection: writer }, id, commitXml("one", ["two", "three", "four"]));
    assert.throws(() => core.addComment({ connection: writer }, id, { author: "writer", content: "late", replyTo: first }), Invalid);
  });

  it("is refused while drafting", () => {
    const { core, id, one } = setup();
    core.submitReview("me", id);
    assert.throws(() => core.addComment("me", id, { author: "miki", content: "late", lineId: one }), NotYourTurn);
  });
});

describe("requestReview and submitReview", () => {
  it("waits on a requested reviewer until it submits, and on me until I do", () => {
    const { core, id, writer, reviewer } = setup();
    core.requestReview("me", id, reviewer);
    assert.deepEqual(core.getText(id).waitsOn.map((w) => w.actor), ["me", { connection: reviewer }]);
    core.submitReview("me", id);
    assert.equal(core.getText(id).state, "in review");
    assert.deepEqual(core.getText(id).waitsOn.map((w) => w.actor), [{ connection: reviewer }]);
    core.submitReview({ connection: reviewer }, id);
    assert.equal(core.getText(id).state, "drafting");
  });

  it("requests a review once per draft", () => {
    const { core, id, writer, reviewer } = setup();
    assert.equal(core.requestReview("me", id, reviewer), core.requestReview("me", id, reviewer));
  });

  it("refuses a review nobody requested, and my review twice", () => {
    const { core, id, writer, reviewer } = setup();
    assert.throws(() => core.submitReview({ connection: reviewer }, id), NotFound);
    core.requestReview("me", id, reviewer);
    core.submitReview("me", id);
    assert.throws(() => core.submitReview("me", id), NotYourTurn);
  });

  it("starts the next round clean: the new draft has no threads and waits on me again", () => {
    const { core, id, writer, one } = setup();
    core.addComment("me", id, { author: "miki", content: "a", lineId: one });
    core.submitReview("me", id);
    assert.deepEqual(core.getText(id).waitsOn, [{ actor: { connection: writer }, role: "writer" }]);
    core.submitDraft({ connection: writer }, id, commitXml("one.", ["two", "three"]));
    assert.deepEqual(core.getDraft(id).threads, []);
    assert.deepEqual(core.getText(id).waitsOn, [{ actor: "me", role: "reviewer" }]);
    assert.equal(core.getDraft(id, 1).threads.length, 1);
  });
});
