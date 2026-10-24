/**
 * The output form of a draft. A draft is stored in review form, one sentence
 * per line: the sentences of a paragraph are joined with a space, an empty
 * line separates paragraphs, a line ending in a backslash keeps its line
 * break, and a list item, a line starting with "- ", starts a line of its own.
 */
export function toOutput(content: string): string {
  const paragraphs: string[][] = [];
  let lines: string[] = [];
  let breakAfter = true; // nothing to join onto at the start of a paragraph
  for (const raw of content.split("\n")) {
    if (raw.trim() === "") {
      if (lines.length) paragraphs.push(lines);
      lines = [];
      breakAfter = true;
      continue;
    }
    const hard = raw.endsWith("\\");
    const text = hard ? raw.slice(0, -1).trimEnd() : raw;
    if (breakAfter || text.startsWith("- ")) lines.push(text);
    else lines[lines.length - 1] += " " + text;
    breakAfter = hard;
  }
  if (lines.length) paragraphs.push(lines);
  return paragraphs.map((p) => p.join("\n") + "\n").join("\n");
}
