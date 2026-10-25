import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Core } from "./core.ts";
import { openDatabase } from "./db.ts";
import { NotApproved, NotYourTurn, ReviewRunning, TextApproved } from "./errors.ts";

const setup = () => {
  const core = new Core(openDatabase(":memory:"));
  const writer = core.connect("@1", "WFC-1145:edit");
  const reviewer = core.connect("@2", "reviewer:fable");
  const id = core.openText("commit", { connection: writer });
  return { core, id, writer, reviewer };
};

describe("approve", () => {
  it("approves the current draft, after which the text waits on nobody and leaves the open list", () => {
    const { core, id } = setup();
    core.submitDraft(id, "scope: Summary\\\n\nOne.\nTwo.");
    core.approve(id);
    const t = core.getText(id);
    assert.equal(t.state, "approved");
    assert.deepEqual(t.waitsOn, []);
    assert.deepEqual(core.listOpenTexts(), []);
  });

  it("approves an amended draft as it stands", () => {
    const { core, id } = setup();
    core.submitDraft(id, "One.\nTow.");
    core.amendDraft(id, 2, ["Two."]);
    core.approve(id);
    assert.equal(core.getResult(id), "One. Two.\n");
  });

  it("is refused while drafting, while a requested review runs, and twice", () => {
    const { core, id, reviewer } = setup();
    assert.throws(() => core.approve(id), NotYourTurn);
    core.submitDraft(id, "a");
    core.requestReview(id, reviewer);
    assert.throws(() => core.approve(id), ReviewRunning);
    core.submitReview(id, { connection: reviewer });
    core.approve(id);
    assert.throws(() => core.approve(id), TextApproved);
  });

  it("closes the text to every change", () => {
    const { core, id, reviewer } = setup();
    core.submitDraft(id, "a");
    core.approve(id);
    assert.throws(() => core.submitDraft(id, "b"), TextApproved);
    assert.throws(() => core.amendDraft(id, 1, ["b"]), TextApproved);
    assert.throws(() => core.addComment(id, { author: "miki", content: "c", line: 1 }), TextApproved);
    assert.throws(() => core.requestReview(id, reviewer), TextApproved);
    assert.throws(() => core.submitReview(id, "me"), TextApproved);
  });
});

describe("getResult", () => {
  it("prints the approved draft in output form", () => {
    const { core, id } = setup();
    core.submitDraft(id, "scope: Summary\\\n\n- one\n- two");
    core.approve(id);
    assert.equal(core.getResult(id), "scope: Summary\n\n- one\n- two\n");
  });

  it("fails for a text that is not approved", () => {
    const { core, id } = setup();
    assert.throws(() => core.getResult(id), NotApproved);
    core.submitDraft(id, "a");
    assert.throws(() => core.getResult(id), NotApproved);
  });
});
