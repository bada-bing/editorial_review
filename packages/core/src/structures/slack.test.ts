import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { slackXml } from "../fixtures.ts";
import { DraftError, assignIds, parseXml, render, rows, toXml } from "../tree.ts";
import { slack } from "./slack.ts";

const s = slack();

describe("the Slack structure", () => {
  it("joins a paragraph's sentences with a space, starts a new line at a break, and separates paragraphs with an empty line", () => {
    const tree = parseXml(slackXml(["One.", "Two.", "<br>", "Three."], ["Four."]));
    s.check(tree);
    assert.equal(render(tree, s), "One. Two.\nThree.\n\nFour.\n");
  });

  it("addresses the sentences and nothing else", () => {
    const tree = assignIds(parseXml(slackXml(["One.", "<br>", "Two."])), s);
    assert.deepEqual(rows(tree, s).map((r) => [r.text, r.path]), [["One.", "message/paragraph[1]/sentence[1]"], ["Two.", "message/paragraph[1]/sentence[2]"]]);
    assert.doesNotMatch(toXml(tree), /<br id=/);
  });

  it("refuses what the structure does not allow, naming the place", () => {
    const refuse = (xml: string, re: RegExp) => assert.throws(() => s.check(parseXml(xml)), (e: Error) => e instanceof DraftError && re.test(e.message));
    refuse("<note/>", /root is <note>, expected <message>/);
    refuse("<message></message>", /needs at least 1 <paragraph>/);
    refuse("<message><line>x</line></message>", /<line> at message\/line\[1\] is not allowed there/);
    refuse("<message><paragraph><br/></paragraph></message>", /needs at least 1 <sentence>/);
    refuse(slackXml(["<br>", "One."]), /<br> at message\/paragraph\[1\]\/br\[1\] stands between two <sentence>s/);
    refuse(slackXml(["One.", "<br>", "<br>", "Two."]), /stands between two <sentence>s/);
    refuse("<message><paragraph><sentence> </sentence></paragraph></message>", /is empty/);
  });

  it("builds a tree from typed text: a sentence per line, <br> for a break, an empty line between paragraphs", () => {
    const tree = s.fromText("One.\nTwo.\n<br>\nThree.\n\nFour.\n");
    s.check(tree);
    assert.equal(render(tree, s), "One. Two.\nThree.\n\nFour.\n");
  });

  it("places each sentence and writes the tree back as the typed text it reads", () => {
    const tree = assignIds(parseXml(slackXml(["One.", "<br>", "Two."], ["Three."])), s);
    const [one, two, three] = rows(tree, s).map((r) => r.id);
    const placed = s.placement(tree);
    assert.deepEqual([placed.get(one!), placed.get(two!), placed.get(three!)], [{ gap: false, br: false }, { gap: false, br: true }, { gap: true, br: false }]);
    assert.equal(s.toText(tree), "One.\n<br>\nTwo.\n\nThree.");
    assert.equal(render(s.fromText(s.toText(tree)), s), render(tree, s));
  });

  it("edits a sentence with the break after it, so an amend can remove the break or add one", () => {
    const tree = assignIds(parseXml(slackXml(["One.", "<br>", "Two."], ["Three."])), s);
    const [one, two, three] = rows(tree, s).map((r) => r.id);
    const edits = s.editTexts(tree);
    assert.equal(edits.get(one!), "One.\n<br>");
    assert.equal(edits.get(two!), "Two.");
    s.amend(tree, one!, ["One, changed."]);
    s.check(tree);
    assert.equal(render(tree, s), "One, changed. Two.\n\nThree.\n");
    assert.equal(rows(tree, s)[0]!.id, one);
    s.amend(tree, three!, []);
    s.check(tree);
    assert.equal(render(tree, s), "One, changed. Two.\n");
    s.amend(tree, two!, ["Two.", "<br>"]);
    s.check(tree);
    assert.equal(render(tree, s), "One, changed. Two.\n");
    s.amend(tree, one!, ["One.", "<br>", "Between."]);
    s.check(tree);
    assert.equal(render(tree, s), "One.\nBetween. Two.\n");
  });
});
