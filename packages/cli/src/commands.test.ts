import { Core, openDatabase } from "@editorial-review/core";
import { COMMIT_TEMPLATES, commitXml, structureFor } from "@editorial-review/core/fixtures";
import { createApi } from "@editorial-review/server/api";
import { Connections } from "@editorial-review/server/connections";
import { Events } from "@editorial-review/server/events";
import { Prompts } from "@editorial-review/server/prompts";
import { Scenarios } from "@editorial-review/server/scenarios";
import { fakeTmux } from "@editorial-review/server/tmux.fake";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { run } from "./commands.ts";

const setup = () => {
  const core = new Core(openDatabase(":memory:"), structureFor);
  const root = mkdtempSync(join(tmpdir(), "scenarios-"));
  mkdirSync(join(root, "commit"), { recursive: true });
  writeFileSync(join(root, "commit", "spec.md"), `# Commit message\n\n\`\`\`template\n${COMMIT_TEMPLATES}\`\`\`\n`);
  const tmux = fakeTmux({ "%1": { id: "@1", name: "WFC-1145:edit" }, "%2": { id: "@2", name: "10x_05:assistant" } });
  const api = createApi(core, new Connections(core, tmux), new Scenarios(root), new Prompts(core, tmux, (s) => s), new Events());
  const fetch = async (url: string, init?: RequestInit) => api.request(url.replace(/^http:\/\/[^/]+\/api/, ""), init);
  const editorial = (pane: string | undefined, argv: string[], stdin = "") => run(argv, { fetch, pane, stdin: () => stdin });
  return { core, editorial };
};

describe("editorial", () => {
  it("runs a commit message from open-text to get-result", async () => {
    const { editorial, core } = setup();
    let r = await editorial("%1", ["open-text", "--scenario", "commit", "--context", "diff=+a"]);
    assert.equal(r.code, 0);
    const id = r.stdout.trim();
    assert.match(id, /^[0-9a-f]{8}$/);
    const writer = core.listConnections()[0]!.id;

    r = await editorial("%1", ["get-text", id]);
    assert.equal(r.stdout, `text ${id}: commit, drafting, version none yet\nwriter: connection ${writer}\nwaits on: connection ${writer} (writer)\ncontext:\n  diff:\n    +a\n`);

    r = await editorial("%1", ["submit-draft", id], commitXml("scope: Summary", ["One.", "Two."]));
    assert.deepEqual(r, { stdout: "1\n", stderr: "", code: 0 });
    const [subject, one, two] = core.getDraft(id).rows;

    r = await editorial("%1", ["get-result", id]);
    assert.equal(r.stdout, "");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not approved/);

    const c1 = core.addComment("me", id, { author: "miki", content: "shorter", lineId: two!.id });
    const c2 = core.addComment("me", id, { author: "miki", content: "good overall" });
    r = await editorial("%1", ["add-comment", id, "--author", "writer", "--reply-to", c1], "like this?\n");
    assert.equal(r.code, 0);
    const c3 = r.stdout.trim();

    r = await editorial("%1", ["get-draft", id]);
    assert.equal(
      r.stdout,
      [
        `text ${id}, version 1 (submitted), in review`,
        `1 + ${subject!.id}  scope: Summary`,
        `2 + ${one!.id}  One.`,
        `3 + ${two!.id}  Two.`,
        `               [${c1} miki] shorter`,
        `                 [${c3} writer] like this?`,
        "on the whole draft:",
        `  [${c2} miki] good overall`,
        "",
      ].join("\n"),
    );
    r = await editorial("%1", ["get-draft", id, "--xml"]);
    assert.match(r.stdout, new RegExp(`<line id="${two!.id}">Two.</line>`));

    core.approve("me", id);
    r = await editorial("%1", ["get-result", id]);
    assert.deepEqual(r, { stdout: "scope: Summary\n\n- One.\n  Two.\n", stderr: "", code: 0 });
  });

  it("reports a refusal on stderr with a non-zero exit", async () => {
    const { editorial } = setup();
    const id = (await editorial("%1", ["open-text", "--scenario", "commit"])).stdout.trim();
    await editorial("%1", ["submit-draft", id], commitXml("a", ["b"]));
    const r = await editorial("%1", ["submit-draft", id], commitXml("b", ["c"]));
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "editorial: cannot submit a draft while the text is in review\n");
    assert.equal((await editorial("%1", ["get-text", "00000009"])).code, 2);
    assert.match((await editorial("%1", ["get-text", "9"])).stderr, /eight hex characters/);
  });

  it("reviews as another connection, and connects under a label", async () => {
    const { editorial, core } = setup();
    const id = (await editorial("%1", ["open-text", "--scenario", "commit"])).stdout.trim();
    await editorial("%1", ["submit-draft", id], commitXml("a", ["b"]));
    await editorial("%2", ["get-text", id]);
    const reviewer = core.findConnection({ label: "10x_05:assistant" })!.id;
    core.requestReview("me", id, reviewer);
    let r = await editorial("%2", ["add-comment", id, "--line", core.getDraft(id).rows[0]!.id], "too short\n");
    assert.equal(r.code, 0);
    r = await editorial("%2", ["submit-review", id]);
    assert.deepEqual(r, { stdout: "", stderr: "", code: 0 });
    r = await editorial("%2", ["connect", "--as", "WFC-1145:edit"]);
    const writer = core.findConnection({ label: "WFC-1145:edit" })!.id;
    assert.equal(r.stdout, `connection ${writer} is now this window, as WFC-1145:edit\n`);
  });

  it("refuses to run outside tmux, and explains its options", async () => {
    const { editorial } = setup();
    const r = await editorial(undefined, ["get-text", "00000001"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /TMUX_PANE/);
    assert.match((await editorial("%1", [])).stdout, /^usage: editorial/);
    assert.match((await editorial("%1", ["open-text"])).stderr, /--scenario/);
  });
});
