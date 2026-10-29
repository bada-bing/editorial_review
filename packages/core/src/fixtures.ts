// Test fixtures shared by the packages' tests: the commit scenario's templates and a draft of it.
import type { Structure } from "./structure.ts";
import { templateStructure } from "./structures/templates.ts";
import { parseTemplates } from "./template.ts";

export const COMMIT_TEMPLATES = `
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

export const SLACK_TEMPLATES = `
message
  separator: blank

  {{paragraph}}+

paragraph
  separator: " "

  {{line}}+

line
  {{text}}
`;

export const structureFor = (scenario: string): Structure =>
  templateStructure(parseTemplates(scenario === "slack" ? SLACK_TEMPLATES : COMMIT_TEMPLATES));

/** A commit draft: the subject, then each bullet as its lines. */
export function commitXml(subject: string, ...bullets: string[][]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const body = bullets.map((b) => `    <bullet>${b.map((l) => `<line>${esc(l)}</line>`).join("")}</bullet>`).join("\n");
  return `<message>\n  <subject><line>${esc(subject)}</line></subject>\n  <body>\n${body}\n  </body>\n</message>\n`;
}

export function slackXml(...paragraphs: string[][]): string {
  return `<message>${paragraphs.map((p) => `<paragraph>${p.map((l) => `<line>${l}</line>`).join("")}</paragraph>`).join("")}</message>`;
}
