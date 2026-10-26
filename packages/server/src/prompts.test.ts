import { Core, openDatabase } from "@editorial-review/core";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Connections } from "./connections.ts";
import { Prompts } from "./prompts.ts";
import { fakeTmux } from "./tmux.fake.ts";

const setup = async () => {
  const core = new Core(openDatabase(":memory:"));
  const tmux = fakeTmux({
    "%1": { id: "@1", name: "WFC-1145:edit", state: "waiting" },
    "%2": { id: "@2", name: "reviewer:fable", state: "idle" },
  });
  const connections = new Connections(core, tmux);
  const writer = (await connections.fromPane("%1")).id;
  const reviewer = (await connections.fromPane("%2")).id;
  const prompts = new Prompts(core, tmux, (s) => `/scenarios/${s}/spec.md`);
  const id = core.openText({ connection: writer }, "commit", { connection: writer });
  return { core, tmux, prompts, id, writer, reviewer };
};

describe("prompts", () => {
  it("tells the writer to draft, naming the spec and the commands", async () => {
    const { tmux, prompts, id } = await setup();
    prompts.draft(id);
    await prompts.deliver();
    assert.equal(tmux.typed.length, 1);
    const [target, line] = tmux.typed[0]!;
    assert.equal(target, "@1");
    assert.match(line, /^Text 1 of the commit scenario is open for you to write/);
    assert.match(line, /\/scenarios\/commit\/spec\.md/);
    assert.match(line, /editorial submit-draft 1 < draft$/);
  });

  it("waits while the window is busy, and types once it is waiting", async () => {
    const { tmux, prompts, id } = await setup();
    tmux.panes["%1"]!.state = "busy";
    prompts.draft(id);
    await prompts.deliver();
    assert.equal(tmux.typed.length, 0);
    assert.equal(prompts.pending(1), 1);
    tmux.panes["%1"]!.state = "waiting";
    await prompts.deliver();
    assert.equal(tmux.typed.length, 1);
    assert.equal(prompts.pending(1), 0);
  });

  it("waits while the window is gone, and reaches the window the connection moves to", async () => {
    const { core, tmux, prompts, id } = await setup();
    tmux.panes["%1"]!.state = "gone";
    prompts.draft(id);
    await prompts.deliver();
    assert.equal(tmux.typed.length, 0);
    tmux.panes["%3"] = { id: "@3", name: "WFC-1145:assistant", state: "idle" };
    core.reconnect(1, "@3");
    await prompts.deliver();
    assert.deepEqual(tmux.typed.map(([t]) => t), ["@3"]);
  });

  it("asks the writer about one thread, and tells the reviewer to review", async () => {
    const { core, tmux, prompts, id, writer, reviewer } = await setup();
    core.submitDraft({ connection: writer }, id, "One.\nTwo.");
    const c = core.addComment("me", id, { author: "miki", content: "Which two?\nBe specific.", line: 2 });
    prompts.ask(id, c);
    core.requestReview("me", id, reviewer);
    prompts.review(id, reviewer);
    await prompts.deliver();
    const lines = Object.fromEntries(tmux.typed);
    assert.match(lines["@1"]!, /^Question on line 2 of text 1, comment 1: Which two\? \/ Be specific\. Answer with: editorial add-comment 1 --author writer --reply-to 1/);
    assert.match(lines["@2"]!, /^Review text 1 of the commit scenario/);
  });

  it("tells the writer to draft again once the review is over, and to take the result once approved", async () => {
    const { core, tmux, prompts, id, writer } = await setup();
    core.submitDraft({ connection: writer }, id, "a");
    core.submitReview("me", id);
    prompts.redraft(id);
    await prompts.deliver();
    assert.match(tmux.typed[0]![1], /^Text 1 was reviewed/);
    core.submitDraft({ connection: writer }, id, "b");
    core.approve("me", id);
    prompts.result(id);
    await prompts.deliver();
    assert.match(tmux.typed[1]![1], /^Text 1 is approved/);
  });

  it("queues one instruction per text and kind, keeping each Ask", async () => {
    const { core, prompts, id, writer } = await setup();
    prompts.draft(id);
    prompts.draft(id);
    assert.equal(prompts.pending(1), 1);
    core.submitDraft({ connection: writer }, id, "a");
    const c = core.addComment("me", id, { author: "miki", content: "x", line: 1 });
    prompts.ask(id, c);
    prompts.ask(id, c);
    assert.equal(prompts.pending(1), 3);
  });

  it("re-derives the draft and review prompts after a restart", async () => {
    const { core, prompts, id, writer, reviewer } = await setup();
    const second = core.openText("me", "commit", { connection: writer });
    core.submitDraft({ connection: writer }, second, "a");
    core.requestReview("me", second, reviewer);
    core.openText("me", "slack", "me");
    prompts.rederive();
    assert.equal(prompts.pending(writer), 1); // the first text, still unwritten
    assert.equal(prompts.pending(reviewer), 1); // the second text's review
    void id;
  });

  it("never prompts for a text I write", async () => {
    const { core, prompts } = await setup();
    const mine = core.openText("me", "slack", "me");
    prompts.draft(mine);
    core.submitDraft("me", mine, "a");
    core.approve("me", mine);
    prompts.result(mine);
    assert.equal(prompts.pending(1), 0);
  });
});
