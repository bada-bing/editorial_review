import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Core } from "./core.ts";
import { openDatabase } from "./db.ts";

const getState = (db: ReturnType<typeof openDatabase>, id: number) => {
  try { return new Core(db).getText(id); } catch { return undefined; }
};

const setup = () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO connection (target, label) VALUES ('@1', 'WFC-1145:edit')").run();
  db.prepare("INSERT INTO text (scenario, writer_connection_id) VALUES ('commit', 1)").run();
  return db;
};

describe("text_state", () => {
  it("is drafting before the first draft, waiting on the writer", () => {
    const s = getState(setup(), 1)!;
    assert.equal(s.state, "drafting");
    assert.equal(s.latestVersion, null);
    assert.deepEqual(s.waitsOn, [{ actor: { connection: 1 }, role: "writer" }]);
  });

  it("is in review from the first draft, waiting on me", () => {
    const db = setup();
    db.prepare("INSERT INTO draft (text_id, version, origin, content) VALUES (1, 1, 'submitted', 'a')").run();
    const s = getState(db, 1)!;
    assert.equal(s.state, "in review");
    assert.equal(s.latestVersion, 1);
    assert.deepEqual(s.waitsOn, [{ actor: "me", role: "reviewer" }]);
  });

  it("is drafting again once I have submitted my review and no requested one is open", () => {
    const db = setup();
    db.prepare("INSERT INTO draft (text_id, version, origin, content) VALUES (1, 1, 'submitted', 'a')").run();
    db.prepare("INSERT INTO review (draft_id, reviewer_connection_id) VALUES (1, 1)").run();
    assert.deepEqual(getState(db, 1)!.waitsOn, [{ actor: "me", role: "reviewer" }, { actor: { connection: 1 }, role: "reviewer" }]);
    db.prepare("INSERT INTO review (draft_id, submitted_at) VALUES (1, 'now')").run();
    assert.deepEqual(getState(db, 1)!.waitsOn, [{ actor: { connection: 1 }, role: "reviewer" }]);
    db.prepare("UPDATE review SET submitted_at = 'now'").run();
    assert.equal(getState(db, 1)!.state, "drafting");
    assert.deepEqual(getState(db, 1)!.waitsOn, [{ actor: { connection: 1 }, role: "writer" }]);
  });

  it("is approved once the text points at a draft, waiting on nobody", () => {
    const db = setup();
    db.prepare("INSERT INTO draft (text_id, version, origin, content) VALUES (1, 1, 'submitted', 'a')").run();
    db.prepare("UPDATE text SET approved_draft_id = 1 WHERE id = 1").run();
    const s = getState(db, 1)!;
    assert.equal(s.state, "approved");
    assert.deepEqual(s.waitsOn, []);
  });

  it("refuses a second review by the same reviewer of one draft, me included", () => {
    const db = setup();
    db.prepare("INSERT INTO draft (text_id, version, origin, content) VALUES (1, 1, 'submitted', 'a')").run();
    db.prepare("INSERT INTO review (draft_id, submitted_at) VALUES (1, 'now')").run();
    assert.throws(() => db.prepare("INSERT INTO review (draft_id, submitted_at) VALUES (1, 'now')").run());
  });

  it("deletes a text's drafts, reviews and comments with it", () => {
    const db = setup();
    db.prepare("INSERT INTO draft (text_id, version, origin, content) VALUES (1, 1, 'submitted', 'a')").run();
    db.prepare("INSERT INTO review (draft_id, submitted_at) VALUES (1, 'now')").run();
    db.prepare("INSERT INTO comment (draft_id, author, line, content) VALUES (1, 'miki', 1, 'c')").run();
    db.prepare("INSERT INTO comment (draft_id, author, parent_id, content) VALUES (1, 'writer', 1, 'r')").run();
    db.prepare("DELETE FROM text WHERE id = 1").run();
    for (const t of ["draft", "review", "comment"]) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0, t);
    }
    assert.equal(getState(db, 1), undefined);
  });
});
