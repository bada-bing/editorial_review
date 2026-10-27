import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Core } from "./core.ts";
import { openDatabase } from "./db.ts";
import { Invalid, NotFound, NotYourTurn, ReviewRunning } from "./errors.ts";
import { commitXml, templatesFor } from "./fixtures.ts";

const setup = () => {
  const db = openDatabase(":memory:");
  const core = new Core(db, templatesFor);
  const writer = core.connect("@1", "WFC-1145:edit");
  const id = core.openText({ connection: writer }, "commit", { connection: writer });
  return { db, core, id, writer, W: { connection: writer } as const };
};

describe("submitDraft", () => {
  it("saves version 1 with an id on every line, after which the text is in review and waits on me", () => {
    const { core, id, W } = setup();
    assert.equal(core.submitDraft(W, id, commitXml("s", ["a", "b"])), 1);
    const t = core.getText(id);
    assert.equal(t.state, "in review");
    assert.deepEqual(t.waitsOn, [{ actor: "me", role: "reviewer" }]);
    const d = core.getDraft(id);
    assert.equal(d.origin, "submitted");
    assert.deepEqual(d.rows.map((r) => [r.n, r.text, r.change]), [[1, "s", "new"], [2, "a", "new"], [3, "b", "new"]]);
    assert.ok(d.rows.every((r) => /^[0-9a-f]{8}$/.test(r.id)));
    assert.match(d.xml, /<line id="[0-9a-f]{8}">s<\/line>/);
  });

  it("refuses a draft that does not fit the scenario's templates, naming the place", () => {
    const { core, id, W } = setup();
    assert.throws(() => core.submitDraft(W, id, "<message><body/></message>"), (e: Error) => e instanceof Invalid && /needs a <subject>/.test(e.message));
    assert.throws(() => core.submitDraft(W, id, "not xml at all <"), Invalid);
    assert.equal(core.getText(id).state, "drafting");
  });

  it("is refused while the text is in review", () => {
    const { core, id, W } = setup();
    core.submitDraft(W, id, commitXml("s", ["a"]));
    assert.throws(() => core.submitDraft(W, id, commitXml("t", ["a"])), NotYourTurn);
  });

  it("numbers versions in order and compares each with the one before by line id", () => {
    const { core, id, db, W } = setup();
    core.submitDraft(W, id, commitXml("s", ["a", "b"]));
    const v1 = core.getDraft(id);
    db.prepare("INSERT INTO review (draft_id, submitted_at) VALUES (1, 'now')").run();
    // The writer keeps the ids of the lines it leaves alone or rewrites.
    const next = v1.xml.replace(">b</line>", ">b, rewritten</line>").replace("</bullet>", "<line>c</line></bullet>");
    assert.equal(core.submitDraft(W, id, next), 2);
    const v2 = core.getDraft(id);
    assert.deepEqual(v2.rows.map((r) => [r.text, r.change]), [["s", "unchanged"], ["a", "unchanged"], ["b, rewritten", "changed"], ["c", "new"]]);
    assert.equal(v2.rows[2]!.id, v1.rows[2]!.id);
    assert.deepEqual(core.getDraft(id, 1).rows.map((r) => r.text), ["s", "a", "b"]);
  });

  it("keeps what a line answers, and refuses an answer to no comment of the text", () => {
    const { core, id, W, db } = setup();
    core.submitDraft(W, id, commitXml("s", ["a"]));
    const c = core.addComment("me", id, { author: "miki", content: "shorter", lineId: core.getDraft(id).rows[1]!.id });
    core.submitReview("me", id);
    const next = core.getDraft(id).xml.replace(">a</line>", ` answers="${c}">a!</line>`);
    core.submitDraft(W, id, next);
    const d = core.getDraft(id);
    assert.deepEqual(d.rows[1]!.answers, [c]);
    assert.deepEqual(d.answered, { [c]: { author: "miki", content: "shorter" } });
    db.prepare("INSERT INTO review (draft_id, submitted_at) VALUES (2, 'now')").run();
    assert.throws(() => core.submitDraft(W, id, d.xml.replace(`answers="${c}"`, 'answers="00000000"')), (e: Error) => e instanceof Invalid && /answers 00000000, which is not a comment/.test(e.message));
  });

  it("gives each row the output line it becomes", () => {
    const { core, id, W } = setup();
    core.submitDraft(W, id, commitXml("s", ["a", "b"]));
    assert.deepEqual(core.getDraft(id).rows.map((r) => r.output), ["s", "- a", "  b"]);
  });
});

describe("amendLine", () => {
  const comment = (core: Core, id: string, lineId: string | undefined, content = "c") =>
    core.addComment("me", id, { author: "miki", content, ...(lineId ? { lineId } : {}) });

  it("replaces one line by several as an amended version, the first keeping its id", () => {
    const { core, id, W } = setup();
    core.submitDraft(W, id, commitXml("one", ["two", "three"]));
    const [, two] = core.getDraft(id).rows;
    assert.equal(core.amendLine("me", id, two!.id, ["two a", "two b"]), 2);
    const d = core.getDraft(id);
    assert.equal(d.origin, "amended");
    assert.deepEqual(d.rows.map((r) => [r.text, r.change]), [["one", "unchanged"], ["two a", "changed"], ["two b", "new"], ["three", "unchanged"]]);
    assert.equal(d.rows[1]!.id, two!.id);
  });

  it("keeps every thread on its line, with nothing moving, and removes a line when nothing replaces it", () => {
    const { core, id, W } = setup();
    core.submitDraft(W, id, commitXml("one", ["two", "three"]));
    const [one, two, three] = core.getDraft(id).rows;
    const first = comment(core, id, one!.id);
    core.addComment("me", id, { author: "writer", content: "r", replyTo: first });
    comment(core, id, two!.id);
    comment(core, id, three!.id);
    comment(core, id, undefined);
    core.amendLine("me", id, two!.id, ["two a", "two b"]);
    const d = core.getDraft(id);
    assert.deepEqual(d.threads.map((t) => [t.lineId, t.comments.length]), [[null, 1], [one!.id, 2], [two!.id, 1], [three!.id, 1]]);
    core.amendLine("me", id, two!.id, []);
    const e = core.getDraft(id);
    assert.deepEqual(e.rows.map((r) => r.text), ["one", "two b", "three"]);
    assert.deepEqual(e.removed.map((r) => r.id), [two!.id]);
    assert.equal(e.threads.find((t) => t.lineId === two!.id)!.comments.length, 1, "a thread on a removed line is kept");
  });

  it("keeps the text in review, still waiting on me", () => {
    const { core, id, W } = setup();
    core.submitDraft(W, id, commitXml("s", ["a"]));
    core.amendLine("me", id, core.getDraft(id).rows[0]!.id, ["t"]);
    assert.deepEqual(core.getText(id).waitsOn, [{ actor: "me", role: "reviewer" }]);
  });

  it("refuses an amend that would break the structure, an unknown line, and the wrong moments", () => {
    const { core, id, W, db, writer } = setup();
    assert.throws(() => core.amendLine("me", id, "00000000", ["b"]), NotYourTurn);
    core.submitDraft(W, id, commitXml("s", ["a"]));
    const [subject, a] = core.getDraft(id).rows;
    assert.throws(() => core.amendLine("me", id, subject!.id, []), Invalid, "a subject with no line");
    assert.throws(() => core.amendLine("me", id, a!.id, []), Invalid, "a bullet with no line");
    assert.throws(() => core.amendLine("me", id, "00000000", ["b"]), NotFound);
    db.prepare("INSERT INTO review (draft_id, reviewer_connection_id) VALUES (1, ?)").run(writer);
    assert.throws(() => core.amendLine("me", id, a!.id, ["b"]), ReviewRunning);
  });
});

describe("draftFromText", () => {
  it("builds the scenario's tree from typed text, keeping the ids of lines that read the same", () => {
    const { core, id, W, db } = setup();
    core.submitDraft(W, id, commitXml("s", ["a", "b"]));
    const [s, a] = core.getDraft(id).rows;
    db.prepare("INSERT INTO review (draft_id, submitted_at) VALUES (1, 'now')").run();
    const xml = core.draftFromText(id, "s\n\n- a\n  b, changed\n- c\n");
    core.submitDraft(W, id, xml);
    const d = core.getDraft(id);
    assert.deepEqual(d.rows.map((r) => [r.text, r.change]), [["s", "unchanged"], ["a", "unchanged"], ["b, changed", "new"], ["c", "new"]]);
    assert.equal(d.rows[0]!.id, s!.id);
    assert.equal(d.rows[1]!.id, a!.id);
  });
});

describe("renderDraft", () => {
  it("renders any version as the output would be", () => {
    const { core, id, W } = setup();
    core.submitDraft(W, id, commitXml("scope: Summary", ["one", "two"], ["three"]));
    assert.equal(core.renderDraft(id), "scope: Summary\n\n- one\n  two\n- three\n");
  });
});
