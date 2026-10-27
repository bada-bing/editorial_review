import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { TemplateError, parseTemplates } from "./template.ts";

export const COMMIT = `
# A commit message: a subject, an empty line, then bullets.
message
  {{subject}}

  {{body}}

subject
  {{line}}

body
  {{bullet}}+

bullet
  - {{line}}
    {{line}}*

line
  width: 70

  {{text}}
`;

export const SLACK = `
message
  separator: blank

  {{paragraph}}+

paragraph
  separator: " "

  {{line}}+

line
  {{text}}
`;

describe("parseTemplates", () => {
  it("reads the blocks, their headers, their templates and the content model", () => {
    const t = parseTemplates(COMMIT);
    assert.equal(t.root, "message");
    assert.deepEqual([...t.blocks.keys()], ["message", "subject", "body", "bullet", "line"]);
    const bullet = t.blocks.get("bullet")!;
    assert.deepEqual(bullet.model, [{ name: "line", min: 1, max: Infinity }]);
    assert.deepEqual(bullet.lines.map((l) => [l.indent, l.pieces.map((p) => (p.kind === "literal" ? p.text : `{{${p.name}}}${p.quantifier}`))]), [
      ["", ["- ", "{{line}}"]],
      ["  ", ["{{line}}*"]],
    ]);
    assert.deepEqual(t.blocks.get("message")!.lines.map((l) => l.pieces.length), [1, 0, 1]);
    assert.deepEqual(t.blocks.get("subject")!.headers, {});
    assert.deepEqual(t.blocks.get("line")!.headers, { width: "70" });
    assert.equal(t.blocks.get("line")!.leaf, true);
  });

  it("reads a separator header with its quotes removed", () => {
    const t = parseTemplates(SLACK);
    assert.deepEqual(t.blocks.get("paragraph")!.headers, { separator: " " });
    assert.deepEqual(t.blocks.get("message")!.headers, { separator: "blank" });
  });

  it("refuses a placeholder with no block, and a block with no template", () => {
    assert.throws(() => parseTemplates("message\n  {{subject}}\n"), TemplateError);
    assert.throws(() => parseTemplates("message\n  width: 70\n"), TemplateError);
  });
});
