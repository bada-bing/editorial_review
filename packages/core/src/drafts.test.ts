import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Core } from "./core.ts";
import { openDatabase } from "./db.ts";
import { NotYourTurn, ReviewRunning } from "./errors.ts";

const setup = () => {
  const db = openDatabase(":memory:");
  const core = new Core(db);
  const writer = core.connect("@1", "WFC-1145:edit");
  const id = core.openText("commit", { connection: writer });
  return { db, core, id, writer };
};
const comment = (db: ReturnType<typeof openDatabase>, draftId: number, line: number | null, parent: number | null = null) =>
  Number(
    db
      .prepare("INSERT INTO comment (draft_id, author, line, parent_id, content) VALUES (?, 'miki', ?, ?, 'c')")
      .run(draftId, line, parent).lastInsertRowid,
  );

describe("submitDraft", () => {
  it("saves version 1, after which the text is in review and waits on me", () => {
    const { core, id } = setup();
    assert.equal(core.submitDraft(id, "a\nb"), 1);
    const t = core.getText(id);
    assert.equal(t.state, "in review");
    assert.deepEqual(t.waitsOn, [{ actor: "me", role: "reviewer" }]);
    assert.equal(core.getDraft(id).origin, "submitted");
  });

  it("is refused while the text is in review", () => {
    const { core, id } = setup();
    core.submitDraft(id, "a");
    assert.throws(() => core.submitDraft(id, "b"), NotYourTurn);
  });

  it("numbers versions in order", () => {
    const { core, id, db } = setup();
    core.submitDraft(id, "a");
    db.prepare("INSERT INTO review (draft_id, submitted_at) VALUES (1, 'now')").run();
    assert.equal(core.submitDraft(id, "b"), 2);
    assert.equal(core.getDraft(id, 1).content, "a");
    assert.equal(core.getDraft(id).content, "b");
  });
});

describe("amendDraft", () => {
  it("replaces one line with several as an amended version", () => {
    const { core, id } = setup();
    core.submitDraft(id, "one\ntwo\nthree");
    assert.equal(core.amendDraft(id, 2, ["two a", "two b"]), 2);
    const d = core.getDraft(id);
    assert.equal(d.origin, "amended");
    assert.equal(d.content, "one\ntwo a\ntwo b\nthree");
  });

  it("moves the threads onto the new version, shifting those below the edited line", () => {
    const { core, id, db } = setup();
    core.submitDraft(id, "one\ntwo\nthree");
    const first = comment(db, 1, 1);
    comment(db, 1, null, first);
    comment(db, 1, 2);
    comment(db, 1, 3);
    comment(db, 1, null);
    core.amendDraft(id, 2, ["two a", "two b"]);
    const lines = core.getDraft(id).threads.map((t) => [t.line, t.comments.length]);
    assert.deepEqual(lines, [[null, 1], [1, 2], [2, 1], [4, 1]]);
    assert.equal(core.getDraft(id, 1).threads.length, 0);
  });

  it("keeps the text in review, still waiting on me", () => {
    const { core, id } = setup();
    core.submitDraft(id, "a");
    core.amendDraft(id, 1, ["b"]);
    assert.deepEqual(core.getText(id).waitsOn, [{ actor: "me", role: "reviewer" }]);
  });

  it("is refused while drafting, and while a requested review runs", () => {
    const { core, id, db, writer } = setup();
    assert.throws(() => core.amendDraft(id, 1, ["b"]), NotYourTurn);
    core.submitDraft(id, "a");
    db.prepare("INSERT INTO review (draft_id, reviewer_connection_id) VALUES (1, ?)").run(writer);
    assert.throws(() => core.amendDraft(id, 1, ["b"]), ReviewRunning);
  });
});
