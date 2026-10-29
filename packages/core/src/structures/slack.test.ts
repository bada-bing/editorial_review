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
});
