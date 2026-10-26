import { Core, openDatabase } from "@editorial-review/core";
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
  const core = new Core(openDatabase(":memory:"));
  const root = mkdtempSync(join(tmpdir(), "scenarios-"));
  mkdirSync(join(root, "commit"), { recursive: true });
  writeFileSync(join(root, "commit", "spec.md"), "# Commit message\n");
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
    assert.deepEqual(r, { stdout: "1\n", stderr: "", code: 0 });

    r = await editorial("%1", ["get-text", "1"]);
    assert.match(r.stdout, /^text 1: commit, drafting, version none yet\nwriter: connection 1\nwaits on: connection 1 \(writer\)\ncontext:\n  diff:\n    \+a\n$/);

    r = await editorial("%1", ["submit-draft", "1"], "scope: Summary\\\n\nOne.\nTwo.\n");
    assert.deepEqual(r, { stdout: "1\n", stderr: "", code: 0 });

    r = await editorial("%1", ["get-result", "1"]);
    assert.equal(r.stdout, "");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not approved/);

    core.addComment("me", 1, { author: "miki", content: "shorter", line: 4 });
    core.addComment("me", 1, { author: "miki", content: "good overall" });
    r = await editorial("%1", ["add-comment", "1", "--author", "writer", "--reply-to", "1"], "like this?\n");
    assert.deepEqual(r, { stdout: "3\n", stderr: "", code: 0 });

    r = await editorial("%1", ["get-draft", "1"]);
    assert.equal(
      r.stdout,
      [
        "text 1, version 1 (submitted), in review",
        "on the whole draft:",
        "  [c2 miki] good overall",
        "1  scope: Summary\\",
        "2  ",
        "3  One.",
        "4  Two.",
        "     [c1 miki] shorter",
        "       [c3 writer] like this?",
        "",
      ].join("\n"),
    );

    core.approve("me", 1);
    r = await editorial("%1", ["get-result", "1"]);
    assert.deepEqual(r, { stdout: "scope: Summary\n\nOne. Two.\n", stderr: "", code: 0 });
  });

  it("reports a refusal on stderr with a non-zero exit", async () => {
    const { editorial } = setup();
    await editorial("%1", ["open-text", "--scenario", "commit"]);
    await editorial("%1", ["submit-draft", "1"], "a\n");
    const r = await editorial("%1", ["submit-draft", "1"], "b\n");
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "editorial: cannot submit a draft while the text is in review\n");
    assert.equal((await editorial("%1", ["get-text", "9"])).code, 2);
  });

  it("reviews as another connection, and connects under a label", async () => {
    const { editorial, core } = setup();
    await editorial("%1", ["open-text", "--scenario", "commit"]);
    await editorial("%1", ["submit-draft", "1"], "a\n");
    await editorial("%2", ["get-text", "1"]);
    core.requestReview("me", 1, 2);
    let r = await editorial("%2", ["add-comment", "1", "--line", "1"], "too short\n");
    assert.equal(r.code, 0);
    r = await editorial("%2", ["submit-review", "1"]);
    assert.deepEqual(r, { stdout: "", stderr: "", code: 0 });
    r = await editorial("%2", ["connect", "--as", "WFC-1145:edit"]);
    assert.equal(r.stdout, "connection 1 is now this window, as WFC-1145:edit\n");
  });

  it("refuses to run outside tmux, and explains its options", async () => {
    const { editorial } = setup();
    const r = await editorial(undefined, ["get-text", "1"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /TMUX_PANE/);
    assert.match((await editorial("%1", [])).stdout, /^usage: editorial/);
    assert.match((await editorial("%1", ["open-text"])).stderr, /--scenario/);
  });
});
