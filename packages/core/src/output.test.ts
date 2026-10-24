import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { toOutput } from "./output.ts";

describe("toOutput", () => {
  it("joins the sentences of a paragraph and separates paragraphs", () => {
    assert.equal(toOutput("One.\nTwo.\n\nThree."), "One. Two.\n\nThree.\n");
  });
  it("keeps a backslash line end as a line break", () => {
    assert.equal(toOutput("scope: Summary\\\n\nbody"), "scope: Summary\n\nbody\n");
    assert.equal(toOutput("a\\\nb\nc"), "a\nb c\n");
  });
  it("keeps list items on their own lines", () => {
    assert.equal(toOutput("- one\n- two\nstill two"), "- one\n- two still two\n");
  });
  it("returns nothing for nothing", () => {
    assert.equal(toOutput(""), "");
  });
});
