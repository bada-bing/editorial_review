import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Core } from "./core.ts";
import { openDatabase } from "./db.ts";
import { NotApproved, NotYourTurn, ReviewRunning, TextApproved } from "./errors.ts";

const setup = () => {
  const core = new Core(openDatabase(":memory:"));
  const writer = core.connect("@1", "WFC-1145:edit");
  const reviewer = core.connect("@2", "reviewer:fable");
  const id = core.openText({ connection: writer }, "commit", { connection: writer });
  return { core, id, writer, reviewer };
};

describe("approve", () => {
  it("approves the current draft, after which the text waits on nobody and leaves the open list", () => {
    const { core, id, writer } = setup();
    core.submitDraft({ connection: writer }, id, "scope: Summary\\\n\nOne.\nTwo.");
    core.approve("me", id);
    const t = core.getText(id);
    assert.equal(t.state, "approved");
    assert.deepEqual(t.waitsOn, []);
    assert.deepEqual(core.listOpenTexts(), []);
  });

  it("approves an amended draft as it stands", () => {
    const { core, id, writer } = setup();
    core.submitDraft({ connection: writer }, id, "One.\nTow.");
    core.amendDraft("me", id, 2, ["Two."]);
    core.approve("me", id);
    assert.equal(core.getResult(id), "One. Two.\n");
  });

  it("is refused while drafting, while a requested review runs, and twice", () => {
    const { core, id, writer, reviewer } = setup();
    assert.throws(() => core.approve("me", id), NotYourTurn);
    core.submitDraft({ connection: writer }, id, "a");
    core.requestReview("me", id, reviewer);
    assert.throws(() => core.approve("me", id), ReviewRunning);
    core.submitReview({ connection: reviewer }, id);
    core.approve("me", id);
    assert.throws(() => core.approve("me", id), TextApproved);
  });

  it("closes the text to every change", () => {
    const { core, id, writer, reviewer } = setup();
    core.submitDraft({ connection: writer }, id, "a");
    core.approve("me", id);
    assert.throws(() => core.submitDraft({ connection: writer }, id, "b"), TextApproved);
    assert.throws(() => core.amendDraft("me", id, 1, ["b"]), TextApproved);
    assert.throws(() => core.addComment("me", id, { author: "miki", content: "c", line: 1 }), TextApproved);
    assert.throws(() => core.requestReview("me", id, reviewer), TextApproved);
    assert.throws(() => core.submitReview("me", id), TextApproved);
  });
});

describe("getResult", () => {
  it("prints the approved draft in output form", () => {
    const { core, id, writer } = setup();
    core.submitDraft({ connection: writer }, id, "scope: Summary\\\n\n- one\n- two");
    core.approve("me", id);
    assert.equal(core.getResult(id), "scope: Summary\n\n- one\n- two\n");
  });

  it("fails for a text that is not approved", () => {
    const { core, id, writer } = setup();
    assert.throws(() => core.getResult(id), NotApproved);
    core.submitDraft({ connection: writer }, id, "a");
    assert.throws(() => core.getResult(id), NotApproved);
  });
});
