import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { templateStructure } from "./structures/templates.ts";
import { parseTemplates } from "./template.ts";
import { COMMIT, SLACK } from "./template.test.ts";
import { DraftError, assignIds, compare, parseXml, render, rows, toXml } from "./tree.ts";

const commit = templateStructure(parseTemplates(COMMIT));
const slack = templateStructure(parseTemplates(SLACK));

const DRAFT = `<message>
  <subject><line>web: Add the review page</line></subject>
  <body>
    <bullet>
      <line>the draft is shown line by line with each thread under its line</line>
      <line>a line takes a comment or an edit, a thread a reply or an Ask</line>
    </bullet>
    <bullet><line>every action is a form posted to a ui route</line></bullet>
  </body>
</message>`;

describe("the tree", () => {
  it("parses a draft, checks it, and renders it as the templates draw it", () => {
    const tree = parseXml(DRAFT);
    commit.check(tree);
    assert.equal(
      render(tree, commit),
      [
        "web: Add the review page",
        "",
        "- the draft is shown line by line with each thread under its line",
        "  a line takes a comment or an edit, a thread a reply or an Ask",
        "- every action is a form posted to a ui route",
        "",
      ].join("\n"),
    );
  });

  it("refuses a line whose output would be over the width, marker and indentation counted", () => {
    const long = "x".repeat(69);
    const ok = parseXml(`<message><subject><line>${"s".repeat(70)}</line></subject><body><bullet><line>${"a".repeat(68)}</line><line>${"b".repeat(68)}</line></bullet></body></message>`);
    commit.check(ok);
    const tooLong = parseXml(`<message><subject><line>s</line></subject><body><bullet><line id="abcd1234">${long}</line></bullet></body></message>`);
    assert.throws(() => commit.check(tooLong), (e: Error) => e instanceof DraftError && /line abcd1234 comes out 71 characters long, over the limit of 70/.test(e.message));
    const subject = parseXml(`<message><subject><line id="00000001">${"s".repeat(71)}</line></subject><body><bullet><line>a</line></bullet></body></message>`);
    assert.throws(() => commit.check(subject), /line 00000001 comes out 71/);
  });

  it("joins a Slack paragraph's lines with a space and separates paragraphs with an empty line", () => {
    const tree = parseXml("<message><paragraph><line>One.</line><line>Two.</line></paragraph><paragraph><line>Three.</line></paragraph></message>");
    slack.check(tree);
    assert.equal(render(tree, slack), "One. Two.\n\nThree.\n");
  });

  it("refuses what the templates do not allow, naming the place", () => {
    const refuse = (xml: string, re: RegExp) => assert.throws(() => commit.check(parseXml(xml)), (e: Error) => e instanceof DraftError && re.test(e.message));
    refuse("<note/>", /root is <note>, expected <message>/);
    refuse("<message><body/></message>", /<message> at message needs a <subject> where <body> is/);
    refuse("<message><subject><line>s</line></subject><body></body></message>", /<body> at message\/body\[1\] needs at least 1 <bullet> where nothing is/);
    refuse("<message><subject><line>s</line><line>t</line></subject><body><bullet><line>b</line></bullet></body></message>", /<line> at message\/subject\[1\] is not allowed there/);
    refuse("<message><subject><line></line></subject><body><bullet><line>b</line></bullet></body></message>", /is empty/);
    refuse("<message><subject>bare text</subject><body><bullet><line>b</line></bullet></body></message>", /<subject> at .* needs a <line>/);
  });

  it("gives every line an id once and keeps the ones it has", () => {
    const tree = assignIds(parseXml(DRAFT), commit);
    const ids = rows(tree, commit).map((r) => r.id);
    assert.equal(ids.length, 4);
    assert.ok(ids.every((id) => /^[0-9a-f]{8}$/.test(id)));
    const again = assignIds(parseXml(toXml(tree)), commit);
    assert.deepEqual(rows(again, commit).map((r) => r.id), ids);
  });

  it("compares versions by id: unchanged, changed, new and removed", () => {
    const v1 = assignIds(parseXml(DRAFT), commit);
    const [a, b, c, d] = rows(v1, commit).map((r) => r.id);
    const v2 = parseXml(toXml(v1));
    const l = (id: string) => v2.children.flatMap((x) => x.children.flatMap((y) => (y.name === "line" ? [y] : y.children))).find((n) => n.attrs["id"] === id)!;
    l(b!).text = "rewritten";
    l(b!).attrs["answers"] = "c1";
    v2.children[1]!.children[1]!.children = []; // removes d
    v2.children[1]!.children[1]!.children.push({ name: "line", attrs: {}, children: [], text: "fresh" });
    assignIds(v2, commit);
    const { rows: r, removed } = compare(v1, v2, commit);
    assert.deepEqual(r.map((x) => [x.change, x.answers]), [["unchanged", []], ["changed", ["c1"]], ["unchanged", []], ["new", []]]);
    assert.deepEqual(removed.map((x) => x.id), [d]);
    void a; void c;
  });

  it("builds a commit tree from typed text, and a Slack one", () => {
    const tree = commit.fromText("web: Add the page\n\n- first bullet\n  continues here\n- second\n");
    commit.check(tree);
    assert.deepEqual(rows(tree, commit).map((r) => r.text), ["web: Add the page", "first bullet", "continues here", "second"]);
    const s = slack.fromText("One.\nTwo.\n\nThree.");
    slack.check(s);
    assert.equal(render(s, slack), "One. Two.\n\nThree.\n");
    assert.throws(() => commit.fromText("subject\n\nno marker here"), DraftError);
  });

  it("writes XML back with ids and answers, readable again", () => {
    const tree = assignIds(parseXml(DRAFT), commit);
    const xml = toXml(tree);
    assert.match(xml, /<line id="[0-9a-f]{8}">web: Add the review page<\/line>/);
    assert.deepEqual(rows(parseXml(xml), commit).map((r) => r.text), rows(tree, commit).map((r) => r.text));
  });
});
