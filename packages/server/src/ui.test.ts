import { Core, openDatabase } from "@editorial-review/core";
import { COMMIT_TEMPLATES, commitXml, slackXml, structureFor } from "@editorial-review/core/fixtures";
import { createUi } from "@editorial-review/web";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createApi } from "./api.ts";
import { Connections } from "./connections.ts";
import { Events } from "./events.ts";
import { Prompts } from "./prompts.ts";
import { Scenarios } from "./scenarios.ts";
import { fakeTmux } from "./tmux.fake.ts";

const setup = async () => {
  const core = new Core(openDatabase(":memory:"), structureFor);
  const root = mkdtempSync(join(tmpdir(), "scenarios-"));
  mkdirSync(join(root, "commit", "examples"), { recursive: true });
  writeFileSync(join(root, "commit", "spec.md"), `# Commit message\n\nSUBJECT-SCOPE. Examples: E1 good.\n\n\`\`\`template\n${COMMIT_TEMPLATES}\`\`\`\n`);
  writeFileSync(join(root, "commit", "examples", "E1.md"), "---\nverdict: good\n---\n# E1\n\n```\nzsh: Disable it\n```\n");
  const tmux = fakeTmux({ "%1": { id: "@1", name: "WFC-1145:edit", state: "waiting" }, "%2": { id: "@2", name: "10x_05:assistant" } });
  const connections = new Connections(core, tmux);
  const api = createApi(core, connections, new Scenarios(root), new Prompts(core, tmux, (s) => s), new Events());
  const ui = createUi((method, path, body) =>
    Promise.resolve(api.request(path.replace(/^\/api/, ""), { method, headers: body === undefined ? {} : { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })),
  );
  const writer = (await connections.fromPane("%1")).id;
  const id = core.openText({ connection: writer }, "commit", { connection: writer }, { intent: "a test" });
  core.submitDraft({ connection: writer }, id, commitXml("scope: Summary", ["One.", "Two."]));
  const [subject, one, two] = core.getDraft(id).rows.map((r) => r.id);
  const post = (path: string, fields: Record<string, string>) =>
    ui.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  return { core, ui, id, writer, post, subject: subject!, one: one!, two: two! };
};

describe("the page", () => {
  it("renders the shell for a text, and redirects / to the first open text", async () => {
    const { ui, id } = await setup();
    const shell = await (await ui.request(`/t/${id}`)).text();
    assert.match(shell, /sse-connect="\/api\/events"/);
    assert.match(shell, new RegExp(`hx-get="/ui/texts/${id}"`));
    assert.match(shell, /<div class="below">[\s\S]*id="guidelines"[\s\S]*id="open-form"/);
    const root = await ui.request("/");
    assert.equal(root.status, 302);
    assert.equal(root.headers.get("location"), `/t/${id}`);
  });

  it("shows the draft line by line with the participants and the controls", async () => {
    const { ui, id, two } = await setup();
    const panel = await (await ui.request(`/ui/texts/${id}`)).text();
    assert.match(panel, new RegExp(`Text ${id} · commit`));
    assert.match(panel, /<span class="role">writer<\/span> <span class="participant ">WFC-1145:edit <span class="state waiting">ready/);
    assert.match(panel, /<span class="role">waits on<\/span> you/);
    assert.match(panel, new RegExp(`id="line-${two}"[\\s\\S]*<span class="number" title="${two}">3</span>\\s*<span class="text">Two\\.`));
    assert.match(panel, /class="gap"/);
    assert.match(panel, /<h3>On the whole draft<\/h3>/);
    assert.match(panel, /Approve<\/button>/);
    assert.doesNotMatch(panel, /Approve<\/button>[\s\S]*disabled/);
  });

  it("comments on a line, replies, asks and amends through the API, re-rendering the panel", async () => {
    const { ui, id, post, core, two } = await setup();
    let panel = await (await post(`/ui/texts/${id}/comments`, { lineId: two, content: "shorter" })).text();
    assert.match(panel, /<span class="author">miki<\/span><span class="body">shorter<\/span>/);
    const first = core.getDraft(id).threads[0]!.comments[0]!.id;
    panel = await (await post(`/ui/texts/${id}/comments`, { replyTo: first, content: "or longer?" })).text();
    assert.match(panel, /class="comment reply"/);
    const reply = core.getDraft(id).threads[0]!.comments[1]!.id;
    assert.equal((await post(`/ui/texts/${id}/ask`, { commentId: reply })).status, 200);
    panel = await (await post(`/ui/texts/${id}/lines/${two}`, { lines: "Two, amended.\nThree." })).text();
    assert.match(panel, /version 2 \(amended\)/);
    assert.match(panel, /class="line changed" id="line-[0-9a-f]{8}"[\s\S]*Two, amended\./);
    assert.match(panel, /class="line new"[\s\S]*<span class="number" title="[0-9a-f]{8}">4<\/span>\s*<span class="text">Three\./);
    assert.equal(core.getDraft(id).threads[0]!.lineId, two);
    assert.match(panel, /<pre id="preview">scope: Summary\n\n- One\.\n  Two, amended\.\n  Three\.\n<\/pre>/);
  });

  it("shows a refusal on the panel instead of failing", async () => {
    const { id, post, subject } = await setup();
    await post(`/ui/texts/${id}/approve`, {});
    const panel = await (await post(`/ui/texts/${id}/comments`, { lineId: subject, content: "late" })).text();
    assert.match(panel, new RegExp(`<div class="error">text ${id} is approved and accepts no change</div>`));
  });

  it("serves the widgets: open texts, context, versions with a diff, guidelines with an example", async () => {
    const { ui, id, post, one } = await setup();
    assert.match(await (await ui.request(`/ui/texts?current=${id}`)).text(), new RegExp(`class="current"[\\s\\S]*${id} · commit`));
    assert.match(await (await ui.request(`/ui/texts/${id}/context`)).text(), /<dt>intent<\/dt><dd>a test<\/dd>/);
    await post(`/ui/texts/${id}/lines/${one}`, { lines: "One, amended." });
    const diff = await (await ui.request(`/ui/texts/${id}/versions/2`)).text();
    assert.match(diff, /<div class="unchanged">scope: Summary<\/div><div class="changed">One, amended\.<\/div><div class="unchanged">Two\.<\/div>/);
    const guide = await (await ui.request(`/ui/texts/${id}/guidelines`)).text();
    assert.match(guide, /<a class="example" href="#" hx-get="\/ui\/scenarios\/commit\/examples\/E1"/);
    assert.match(await (await ui.request(`/ui/scenarios/commit/examples/E1`)).text(), /<strong>E1<\/strong>\n# E1/);
  });

  it("opens a text from the form and drops one, redirecting the page", async () => {
    const { ui, id, post } = await setup();
    const opened = await post("/ui/texts", { scenario: "commit", writer: "me", intent: "x" });
    assert.match(opened.headers.get("HX-Redirect")!, /^\/t\/[0-9a-f]{8}$/);
    const dropped = await ui.request(`/ui/texts/${id}`, { method: "DELETE" });
    assert.equal(dropped.headers.get("HX-Redirect"), "/");
  });

  it("places the rows as the structure says: a gap between paragraphs, a mark at a break", async () => {
    const { ui, core } = await setup();
    const id = core.openText("me", "slack", "me");
    core.submitDraft("me", id, slackXml(["One.", "<br>", "Two."], ["Three."]));
    const panel = await (await ui.request(`/ui/texts/${id}`)).text();
    assert.match(panel, /One\.[\s\S]*<div class="break"[^>]*>↵<\/div><div class="line new" [\s\S]*Two\.[\s\S]*<div class="gap"><\/div><div class="line new" [\s\S]*Three\./);
  });

  it("serves its assets", async () => {
    const { ui } = await setup();
    for (const [name, type] of [["style.css", "text/css"], ["htmx.min.js", "text/javascript"], ["sse.min.js", "text/javascript"]]) {
      const res = await ui.request(`/assets/${name}`);
      assert.equal(res.status, 200, name);
      assert.equal(res.headers.get("content-type"), type);
    }
  });
});
