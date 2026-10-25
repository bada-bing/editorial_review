import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Core } from "./core.ts";
import { openDatabase } from "./db.ts";
import { Invalid, NotFound, NotYourTurn } from "./errors.ts";

const setup = () => {
  const core = new Core(openDatabase(":memory:"));
  const writer = core.connect("@1", "WFC-1145:edit");
  const reviewer = core.connect("@2", "reviewer:fable");
  const id = core.openText({ connection: writer }, "commit", { connection: writer });
  core.submitDraft({ connection: writer }, id, "one\ntwo\nthree");
  return { core, id, writer, reviewer };
};

describe("addComment", () => {
  it("starts a thread on a line or on the whole draft, and a reply joins the thread of the comment it answers", () => {
    const { core, id, writer } = setup();
    const first = core.addComment("me", id, { author: "miki", content: "shorter", line: 2 });
    core.addComment("me", id, { author: "miki", content: "too long overall" });
    const answer = core.addComment({ connection: writer }, id, { author: "writer", content: "like this?", replyTo: first });
    core.addComment("me", id, { author: "miki", content: "yes", replyTo: answer });
    const threads = core.getDraft(id).threads;
    assert.deepEqual(threads.map((t) => [t.line, t.comments.map((c) => [c.author, c.parentId])]), [
      [null, [["miki", null]]],
      [2, [["miki", null], ["writer", first], ["miki", answer]]],
    ]);
  });

  it("refuses a line outside the draft, a reply to a comment of another draft, and both at once", () => {
    const { core, id, writer } = setup();
    const first = core.addComment("me", id, { author: "miki", content: "a", line: 1 });
    assert.throws(() => core.addComment("me", id, { author: "miki", content: "c", line: 4 }), Invalid);
    assert.throws(() => core.addComment("me", id, { author: "miki", content: "c", line: 1, replyTo: first }), Invalid);
    core.submitReview("me", id);
    core.submitDraft({ connection: writer }, id, "one\ntwo\nthree\nfour");
    assert.throws(() => core.addComment({ connection: writer }, id, { author: "writer", content: "late", replyTo: first }), Invalid);
  });

  it("is refused while drafting", () => {
    const { core, id, writer } = setup();
    core.submitReview("me", id);
    assert.throws(() => core.addComment("me", id, { author: "miki", content: "late", line: 1 }), NotYourTurn);
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
    const { core, id, writer } = setup();
    core.addComment("me", id, { author: "miki", content: "a", line: 1 });
    core.submitReview("me", id);
    assert.deepEqual(core.getText(id).waitsOn, [{ actor: { connection: writer }, role: "writer" }]);
    core.submitDraft({ connection: writer }, id, "one.\ntwo\nthree");
    assert.deepEqual(core.getDraft(id).threads, []);
    assert.deepEqual(core.getText(id).waitsOn, [{ actor: "me", role: "reviewer" }]);
    assert.equal(core.getDraft(id, 1).threads.length, 1);
  });
});
