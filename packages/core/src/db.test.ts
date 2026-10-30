import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Core } from "./core.ts";
import { commitXml, structureFor } from "./fixtures.ts";
import { openDatabase } from "./db.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Invalid } from "./errors.ts";

const getState = (db: ReturnType<typeof openDatabase>, id: string) => {
  try { return new Core(db, structureFor).getText(id); } catch { return undefined; }
};

const setup = () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO connection (id, target, label) VALUES ('c1', '@1', 'WFC-1145:edit')").run();
  db.prepare("INSERT INTO text (id, scenario, writer_connection_id) VALUES ('t1', 'commit', 'c1')").run();
  return db;
};

describe("text_state", () => {
  it("is drafting before the first draft, waiting on the writer", () => {
    const s = getState(setup(), 't1')!;
    assert.equal(s.state, "drafting");
    assert.equal(s.latestVersion, null);
    assert.deepEqual(s.waitsOn, [{ actor: { connection: 'c1' }, role: "writer" }]);
  });

  it("is in review from the first draft, waiting on me", () => {
    const db = setup();
    db.prepare("INSERT INTO draft (text_id, version, origin, content) VALUES ('t1', 1, 'submitted', 'a')").run();
    const s = getState(db, 't1')!;
    assert.equal(s.state, "in review");
    assert.equal(s.latestVersion, 1);
    assert.deepEqual(s.waitsOn, [{ actor: "me", role: "reviewer" }]);
  });

  it("is drafting again once I have submitted my review and no requested one is open", () => {
    const db = setup();
    db.prepare("INSERT INTO draft (text_id, version, origin, content) VALUES ('t1', 1, 'submitted', 'a')").run();
    db.prepare("INSERT INTO review (draft_id, reviewer_connection_id) VALUES (1, 'c1')").run();
    assert.deepEqual(getState(db, 't1')!.waitsOn, [{ actor: "me", role: "reviewer" }, { actor: { connection: 'c1' }, role: "reviewer" }]);
    db.prepare("INSERT INTO review (draft_id, submitted_at) VALUES (1, 'now')").run();
    assert.deepEqual(getState(db, 't1')!.waitsOn, [{ actor: { connection: 'c1' }, role: "reviewer" }]);
    db.prepare("UPDATE review SET submitted_at = 'now'").run();
    assert.equal(getState(db, 't1')!.state, "drafting");
    assert.deepEqual(getState(db, 't1')!.waitsOn, [{ actor: { connection: 'c1' }, role: "writer" }]);
  });

  it("is approved once the text points at a draft, waiting on nobody", () => {
    const db = setup();
    db.prepare("INSERT INTO draft (text_id, version, origin, content) VALUES ('t1', 1, 'submitted', 'a')").run();
    db.prepare("UPDATE text SET approved_draft_id = 1 WHERE id = 't1'").run();
    const s = getState(db, 't1')!;
    assert.equal(s.state, "approved");
    assert.deepEqual(s.waitsOn, []);
  });

  it("refuses a second review by the same reviewer of one draft, me included", () => {
    const db = setup();
    db.prepare("INSERT INTO draft (text_id, version, origin, content) VALUES ('t1', 1, 'submitted', 'a')").run();
    db.prepare("INSERT INTO review (draft_id, submitted_at) VALUES (1, 'now')").run();
    assert.throws(() => db.prepare("INSERT INTO review (draft_id, submitted_at) VALUES (1, 'now')").run());
  });

  it("deletes a text's drafts, reviews and comments with it", () => {
    const db = setup();
    db.prepare("INSERT INTO draft (text_id, version, origin, content) VALUES ('t1', 1, 'submitted', 'a')").run();
    db.prepare("INSERT INTO review (draft_id, submitted_at) VALUES (1, 'now')").run();
    db.prepare("INSERT INTO comment (id, draft_id, author, line_id, content) VALUES ('k1', 1, 'miki', 'l1', 'c')").run();
    db.prepare("INSERT INTO comment (id, draft_id, author, parent_id, content) VALUES ('k2', 1, 'writer', 'k1', 'r')").run();
    db.prepare("DELETE FROM text WHERE id = 't1'").run();
    for (const t of ["draft", "review", "comment"]) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0, t);
    }
    assert.equal(getState(db, 't1'), undefined);
  });
});

describe("connection labels", () => {
  it("are made unique in a database from before they were, the first holder keeping its label", () => {
    const path = join(mkdtempSync(join(tmpdir(), "editorial-")), "old.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE connection (id TEXT PRIMARY KEY, target TEXT NOT NULL UNIQUE, label TEXT NOT NULL)");
    old.exec("INSERT INTO connection VALUES ('aaaaaaaa', '@1', '10x_15:editorial'), ('bbbbbbbb', '@2', '10x_15:editorial')");
    old.close();
    const db = openDatabase(path);
    assert.deepEqual(db.prepare("SELECT id, label FROM connection ORDER BY rowid").all().map((r) => [r["id"], r["label"]]), [["aaaaaaaa", "10x_15:editorial"], ["bbbbbbbb", "10x_15:editorial#bbbbbbbb"]]);
    assert.throws(() => db.exec("INSERT INTO connection VALUES ('cccccccc', '@3', '10x_15:editorial')"));
  });

  it("are given a suffix when taken, and refused to a relabel", () => {
    const core = new Core(openDatabase(":memory:"), structureFor);
    const a = core.connect("@1", "10x_15:editorial");
    const b = core.connect("@2", "10x_15:editorial");
    assert.equal(core.findConnection({ target: "@2" })!.label, `10x_15:editorial#${b}`);
    assert.throws(() => core.relabel(b, "10x_15:editorial"), Invalid);
    core.relabel(a, "10x_15:editorial");
  });
});

