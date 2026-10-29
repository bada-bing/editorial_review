import { Core, openDatabase } from "@editorial-review/core";
import { COMMIT_TEMPLATES, commitXml, structureFor } from "@editorial-review/core/fixtures";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Connections } from "./connections.ts";
import { Prompts } from "./prompts.ts";
import { fakeTmux } from "./tmux.fake.ts";

const setup = async () => {
  const core = new Core(openDatabase(":memory:"), structureFor);
  const tmux = fakeTmux({
    "%1": { id: "@1", name: "WFC-1145:edit", state: "waiting" },
    "%2": { id: "@2", name: "reviewer:fable", state: "idle" },
  });
  const connections = new Connections(core, tmux);
  const writer = (await connections.fromPane("%1")).id;
  const reviewer = (await connections.fromPane("%2")).id;
  const prompts = new Prompts(core, tmux, (s) => `/scenarios/${s}/spec.md`, (s) => structureFor(s).notation);
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
    assert.match(line, new RegExp(`^Text ${id} of the commit scenario is open for you to write`));
    assert.match(line, /\/scenarios\/commit\/spec\.md/);
    assert.match(line, /written in the notation defined at \/\S+\/structures\/templates\.md,/);
    assert.match(line, new RegExp(`editorial submit-draft ${id} < draft.xml$`));
  });

  it("waits while the window is busy, and types once it is waiting", async () => {
    const { tmux, prompts, id, writer } = await setup();
    tmux.panes["%1"]!.state = "busy";
    prompts.draft(id);
    await prompts.deliver();
    assert.equal(tmux.typed.length, 0);
    assert.equal(prompts.pending(writer), 1);
    tmux.panes["%1"]!.state = "waiting";
    await prompts.deliver();
    assert.equal(tmux.typed.length, 1);
    assert.equal(prompts.pending(writer), 0);
  });

  it("waits while the window is gone, and reaches the window the connection moves to", async () => {
    const { core, tmux, prompts, id, writer } = await setup();
    tmux.panes["%1"]!.state = "gone";
    prompts.draft(id);
    await prompts.deliver();
    assert.equal(tmux.typed.length, 0);
    tmux.panes["%3"] = { id: "@3", name: "WFC-1145:assistant", state: "idle" };
    core.reconnect(writer, "@3");
    await prompts.deliver();
    assert.deepEqual(tmux.typed.map(([t]) => t), ["@3"]);
  });

  it("asks the writer about one thread, and tells the reviewer to review", async () => {
    const { core, tmux, prompts, id, writer, reviewer } = await setup();
    core.submitDraft({ connection: writer }, id, commitXml("One.", ["Two."]));
    const two = core.getDraft(id).rows[1]!.id;
    const c = core.addComment("me", id, { author: "miki", content: "Which two?\nBe specific.", lineId: two });
    prompts.ask(id, c);
    core.requestReview("me", id, reviewer);
    prompts.review(id, reviewer);
    await prompts.deliver();
    const lines = Object.fromEntries(tmux.typed);
    assert.match(lines["@1"]!, new RegExp(`^Question on line ${two} of text ${id}, comment ${c}: Which two\\? / Be specific\\. Answer with: editorial add-comment ${id} --author writer --reply-to ${c}`));
    assert.match(lines["@2"]!, new RegExp(`^Review text ${id} of the commit scenario`));
  });

  it("tells the writer to draft again once the review is over, and the opener to take the result once approved", async () => {
    const { core, tmux, prompts, id, writer } = await setup();
    core.submitDraft({ connection: writer }, id, commitXml("a", ["b"]));
    core.submitReview("me", id);
    prompts.redraft(id);
    await prompts.deliver();
    assert.match(tmux.typed[0]![1], new RegExp(`^Text ${id} was reviewed`));
    core.submitDraft({ connection: writer }, id, commitXml("b", ["c"]));
    core.approve("me", id);
    prompts.result(id);
    await prompts.deliver();
    assert.match(tmux.typed[1]![1], new RegExp(`^Text ${id} is approved`));
  });

  it("queues one instruction per text and kind, keeping each Ask", async () => {
    const { core, prompts, id, writer } = await setup();
    prompts.draft(id);
    prompts.draft(id);
    assert.equal(prompts.pending(writer), 1);
    core.submitDraft({ connection: writer }, id, commitXml("a", ["b"]));
    const c = core.addComment("me", id, { author: "miki", content: "x", lineId: core.getDraft(id).rows[0]!.id });
    prompts.ask(id, c);
    prompts.ask(id, c);
    assert.equal(prompts.pending(writer), 3);
  });

  it("re-derives the draft and review prompts after a restart", async () => {
    const { core, prompts, id, writer, reviewer } = await setup();
    const second = core.openText("me", "commit", { connection: writer });
    core.submitDraft({ connection: writer }, second, commitXml("a", ["b"]));
    core.requestReview("me", second, reviewer);
    core.openText("me", "slack", "me");
    prompts.rederive();
    assert.equal(prompts.pending(writer), 1); // the first text, still unwritten
    assert.equal(prompts.pending(reviewer), 1); // the second text's review
    void id;
  });

  it("discards a dropped text's queued prompts and tells the writer", async () => {
    const { core, tmux, prompts, id, writer } = await setup();
    tmux.panes["%1"]!.state = "busy";
    prompts.draft(id);
    prompts.dropped(id);
    core.drop("me", id);
    tmux.panes["%1"]!.state = "waiting";
    await prompts.deliver();
    assert.equal(prompts.pending(writer), 0);
    assert.deepEqual(tmux.typed.map(([, l]) => l.split(".")[0]), [`Text ${id} was dropped`]);
  });

  it("drops a draft prompt whose draft arrived while the window was busy", async () => {
    const { core, tmux, prompts, id, writer } = await setup();
    tmux.panes["%1"]!.state = "busy";
    prompts.draft(id);
    core.submitDraft({ connection: writer }, id, commitXml("a", ["b"]));
    tmux.panes["%1"]!.state = "waiting";
    await prompts.deliver();
    assert.equal(tmux.typed.length, 0);
    assert.equal(prompts.pending(writer), 0);
  });

  it("sends the result to the one that opened the text, and tells its writer the text is approved", async () => {
    const { core, tmux, prompts, writer, reviewer } = await setup();
    const id = core.openText({ connection: reviewer }, "commit", { connection: writer });
    core.submitDraft({ connection: writer }, id, commitXml("a", ["b"]));
    core.approve("me", id);
    prompts.result(id);
    await prompts.deliver();
    assert.deepEqual(tmux.typed.map(([t, l]) => [t, l.split(".")[0]]), [["@2", `Text ${id} is approved`], ["@1", `Text ${id}, which you wrote, is approved`]]);
  });

  it("never prompts for a text I write", async () => {
    const { core, prompts, writer } = await setup();
    const mine = core.openText("me", "slack", "me");
    prompts.draft(mine);
    core.submitDraft("me", mine, "<message><paragraph><sentence>a</sentence></paragraph></message>");
    core.approve("me", mine);
    prompts.result(mine);
    assert.equal(prompts.pending(writer), 0);
  });
});
