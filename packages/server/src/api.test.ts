import { Core, openDatabase } from "@editorial-review/core";
import { COMMIT_TEMPLATES, commitXml, structureFor } from "@editorial-review/core/fixtures";
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

const setup = () => {
  const core = new Core(openDatabase(":memory:"), structureFor);
  const root = mkdtempSync(join(tmpdir(), "scenarios-"));
  mkdirSync(join(root, "commit", "examples"), { recursive: true });
  writeFileSync(join(root, "commit", "spec.md"), `# Commit message\n\n## Structure\n\n\`\`\`template\n${COMMIT_TEMPLATES}\`\`\`\n`);
  writeFileSync(join(root, "commit", "examples", "E1.md"), "---\nverdict: good\n---\n");
  const tmux = fakeTmux({ "%1": { id: "@1", name: "WFC-1145:edit" }, "%2": { id: "@2", name: "10x_05:assistant" } });
  const prompts = new Prompts(core, tmux, (s) => `${root}/${s}/spec.md`);
  const events = new Events();
  const api = createApi(core, new Connections(core, tmux), new Scenarios(root), prompts, events);
  const call = (method: string, path: string, body?: unknown, pane?: string) =>
    api.request(path, {
      method,
      headers: { "content-type": "application/json", ...(pane ? { "X-Tmux-Pane": pane } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { core, call, tmux, prompts, events, api };
};

describe("the API", () => {
  it("runs a text from opening to the result", async () => {
    const { call } = setup();
    let r = await call("POST", "/texts", { scenario: "commit" }, "%1");
    assert.equal(r.status, 201);
    const { id } = (await r.json()) as { id: string };

    r = await call("GET", `/texts/${id}`);
    const writer = (await (await call("GET", "/connections")).json()) as { id: string }[];
    assert.deepEqual(((await r.json()) as { writer: unknown }).writer, { connection: writer[0]!.id });

    r = await call("POST", `/texts/${id}/drafts`, { xml: commitXml("scope: Summary", ["One.", "Two."]) }, "%1");
    assert.deepEqual(await r.json(), { version: 1 });
    const draft0 = (await (await call("GET", `/texts/${id}/drafts/latest`)).json()) as { rows: { id: string; text: string }[] };
    const two = draft0.rows.find((x) => x.text === "Two.")!.id;

    r = await call("POST", `/texts/${id}/comments`, { content: "shorter", lineId: two });
    const { id: commentId } = (await r.json()) as { id: string };
    r = await call("POST", `/texts/${id}/comments`, { content: "like this?", replyTo: commentId }, "%1");
    assert.equal(r.status, 201);
    r = await call("GET", `/texts/${id}/drafts/latest`);
    const draft = (await r.json()) as { threads: { comments: { author: string }[] }[] };
    assert.deepEqual(draft.threads[0]!.comments.map((c) => c.author), ["me", "WFC-1145:edit"]);

    r = await call("POST", `/texts/${id}/lines/${two}`, { lines: ["Two, amended."] });
    assert.deepEqual(await r.json(), { version: 2 });
    assert.equal(await (await call("GET", `/texts/${id}/drafts/latest/output`)).text(), "scope: Summary\n\n- One.\n  Two, amended.\n");

    r = await call("GET", `/texts/${id}/result`);
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { error: string }).error, "NotApproved");

    r = await call("POST", `/texts/${id}/approve`);
    assert.equal(r.status, 204);
    r = await call("GET", `/texts/${id}/result`);
    assert.equal(await r.text(), "scope: Summary\n\n- One.\n  Two, amended.\n");
    assert.deepEqual(await (await call("GET", "/texts")).json(), []);
  });

  it("refuses to an agent what is mine, with the error as JSON", async () => {
    const { call } = setup();
    const { id } = (await (await call("POST", "/texts", { scenario: "commit" }, "%1")).json()) as { id: string };
    await call("POST", `/texts/${id}/drafts`, { xml: commitXml("a", ["b"]) }, "%1");
    const r = await call("POST", `/texts/${id}/approve`, undefined, "%1");
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: "Forbidden", message: "an agent may not approve a text" });
    assert.equal((await call("DELETE", `/texts/${id}`, undefined, "%1")).status, 403);
    assert.equal((await call("DELETE", `/texts/${id}`)).status, 204);
  });

  it("maps the other errors to their statuses", async () => {
    const { call } = setup();
    assert.equal((await call("GET", "/texts/00000099")).status, 404);
    assert.equal((await call("GET", "/texts/99")).status, 400);
    assert.equal((await call("POST", "/texts", { scenario: "slack" })).status, 404);
    assert.equal((await call("POST", "/texts", {})).status, 400);
    const { id } = (await (await call("POST", "/texts", { scenario: "commit", writer: "me" })).json()) as { id: string };
    assert.equal((await call("POST", `/texts/${id}/approve`)).status, 409);
    assert.equal((await call("POST", `/texts/${id}/comments`, { content: "x" })).status, 409);
    assert.equal((await call("POST", `/texts/${id}/drafts`, { xml: "<message/>" })).status, 400);
  });

  it("requests and submits reviews", async () => {
    const { call } = setup();
    const { id } = (await (await call("POST", "/texts", { scenario: "commit" }, "%1")).json()) as { id: string };
    await call("POST", `/texts/${id}/drafts`, { xml: commitXml("a", ["b"]) }, "%1");
    assert.equal(((await (await call("GET", "/connections")).json()) as unknown[]).length, 1);
    await call("GET", "/texts", undefined, "%2"); // the reviewer's window reaches the server
    const rows = (await (await call("GET", "/connections")).json()) as { id: string; label: string }[];
    const reviewer = rows.find((r) => r.label === "10x_05:assistant")!.id;
    assert.equal((await call("POST", `/texts/${id}/reviews`, { reviewer })).status, 201);
    assert.equal((await call("POST", `/texts/${id}/reviews/submit`)).status, 204);
    assert.equal(((await (await call("GET", `/texts/${id}`)).json()) as { state: string }).state, "in review");
    assert.equal((await call("POST", `/texts/${id}/reviews/submit`, undefined, "%2")).status, 204);
    assert.equal(((await (await call("GET", `/texts/${id}`)).json()) as { state: string }).state, "drafting");
  });

  it("serves the scenarios", async () => {
    const { call } = setup();
    assert.deepEqual(await (await call("GET", "/scenarios")).json(), ["commit"]);
    const s = (await (await call("GET", "/scenarios/commit")).json()) as { spec: string; examples: Record<string, string> };
    assert.match(s.spec, /^# Commit message\n/);
    assert.ok(s.spec.includes(COMMIT_TEMPLATES));
    assert.deepEqual(Object.keys(s.examples), ["E1"]);
    assert.equal((await call("GET", "/scenarios/slack")).status, 404);
  });
});

describe("the event stream", () => {
  it("announces the participants first, then every change to a text", async () => {
    const { call, api } = setup();
    await call("GET", "/texts", undefined, "%1"); // one connection exists
    const res = await api.request("/events");
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const next = async () => decoder.decode((await reader.read()).value);

    assert.match(await next(), /^event: connections\ndata: \[\{"id":"[0-9a-f]{8}",/);

    const { id } = (await (await call("POST", "/texts", { scenario: "commit" }, "%1")).json()) as { id: string };
    assert.equal(await next(), `event: text\ndata: {"id":"${id}","state":"drafting","latestVersion":null}\n\n`);

    await call("POST", `/texts/${id}/drafts`, { xml: commitXml("a", ["b"]) }, "%1");
    assert.equal(await next(), `event: text\ndata: {"id":"${id}","state":"in review","latestVersion":1}\n\n`);

    await call("DELETE", `/texts/${id}`);
    assert.equal(await next(), `event: text\ndata: {"id":"${id}","dropped":true}\n\n`);
    await reader.cancel();
  });
});
