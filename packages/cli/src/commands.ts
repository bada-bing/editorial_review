import type { Draft, TextState } from "@editorial-review/core";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface Io {
  /** The server's fetch; tests hand in the app's request handler. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** The caller's tmux pane, from $TMUX_PANE; undefined outside tmux. */
  pane: string | undefined;
  /** The whole of stdin, read when a command takes its body there. */
  stdin: () => string;
}

export interface Outcome {
  stdout: string;
  stderr: string;
  code: number;
}

const USAGE = `usage: editorial <command> [options]

  connect        --as <label>                      take over that label's connection
  open-text      --scenario <s> [--writer me]      open a text; prints its id
                 [--context <name>=<value|@file>]...
  get-text       <id>                              the text's state and context
  get-draft      <id> [--version <n>]              a draft with its threads; the latest by default
  submit-draft   <id> < body                       the next version, in review form
  add-comment    <id> [--author <label>]           a thread on a line or on the whole draft,
                 [--line <n> | --reply-to <id>] < body   or a reply
  submit-review  <id>                              end your review
  get-result     <id>                              the approved text; fails unless approved
`;

class Failure extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

/** Runs one command; nothing is printed here, the outcome says what to print and the exit code. */
export async function run(argv: string[], io: Io): Promise<Outcome> {
  try {
    const out = await dispatch(argv, io);
    return { stdout: out, stderr: "", code: 0 };
  } catch (e) {
    if (e instanceof Failure) return { stdout: "", stderr: `editorial: ${e.message}\n`, code: e.code };
    return { stdout: "", stderr: `editorial: ${(e as Error).message}\n`, code: 1 };
  }
}

async function dispatch(argv: string[], io: Io): Promise<string> {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help") return USAGE;
  const api = client(io);
  switch (command) {
    case "connect": {
      const { values } = parseArgs({ args: rest, options: { as: { type: "string" } } });
      if (!values.as) throw new Failure("connect needs --as <label>");
      const c = (await api("POST", "/api/connections", { label: values.as })) as { id: number; label: string };
      return `connection ${c.id} is now this window, as ${c.label}\n`;
    }
    case "open-text": {
      const { values } = parseArgs({
        args: rest,
        options: { scenario: { type: "string" }, writer: { type: "string" }, context: { type: "string", multiple: true } },
      });
      if (!values.scenario) throw new Failure("open-text needs --scenario <name>");
      if (values.writer !== undefined && values.writer !== "me") throw new Failure("--writer takes only me; leave it out to write the text yourself");
      const context: Record<string, string> = {};
      for (const item of values.context ?? []) {
        const eq = item.indexOf("=");
        if (eq < 1) throw new Failure(`--context takes <name>=<value>, not ${item}`);
        const value = item.slice(eq + 1);
        context[item.slice(0, eq)] = value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value;
      }
      const body = { scenario: values.scenario, context, ...(values.writer ? { writer: "me" } : {}) };
      const t = (await api("POST", "/api/texts", body)) as { id: number };
      return `${t.id}\n`;
    }
    case "get-text": {
      const id = textId(rest);
      return formatText((await api("GET", `/api/texts/${id}`)) as TextState);
    }
    case "get-draft": {
      const { values, positionals } = parseArgs({ args: rest, options: { version: { type: "string" } }, allowPositionals: true });
      const id = textId(positionals);
      const version = values.version ?? "latest";
      const text = (await api("GET", `/api/texts/${id}`)) as TextState;
      return formatDraft(text, (await api("GET", `/api/texts/${id}/drafts/${version}`)) as Draft);
    }
    case "submit-draft": {
      const id = textId(rest);
      const content = io.stdin();
      if (content.trim() === "") throw new Failure("submit-draft reads the draft from stdin, and it was empty");
      const r = (await api("POST", `/api/texts/${id}/drafts`, { content: content.replace(/\n$/, "") })) as { version: number };
      return `${r.version}\n`;
    }
    case "add-comment": {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { author: { type: "string" }, line: { type: "string" }, "reply-to": { type: "string" } },
        allowPositionals: true,
      });
      const id = textId(positionals);
      if (values.line !== undefined && values["reply-to"] !== undefined) throw new Failure("--line and --reply-to exclude each other");
      const content = io.stdin().replace(/\n$/, "");
      if (content.trim() === "") throw new Failure("add-comment reads the comment from stdin, and it was empty");
      const body = {
        content,
        ...(values.author ? { author: values.author } : {}),
        ...(values.line !== undefined ? { line: number(values.line, "--line") } : {}),
        ...(values["reply-to"] !== undefined ? { replyTo: number(values["reply-to"], "--reply-to") } : {}),
      };
      const r = (await api("POST", `/api/texts/${id}/comments`, body)) as { id: number };
      return `${r.id}\n`;
    }
    case "submit-review": {
      await api("POST", `/api/texts/${textId(rest)}/reviews/submit`);
      return "";
    }
    case "get-result": {
      // Prints only an approved text, so `git commit -F` can never take a draft.
      return (await api("GET", `/api/texts/${textId(rest)}/result`)) as string;
    }
    default:
      throw new Failure(`unknown command ${command}\n\n${USAGE}`);
  }
}

const textId = (positionals: string[]): number => {
  const [id, extra] = positionals;
  if (!id) throw new Failure("the text's id is required");
  if (extra) throw new Failure(`unexpected argument ${extra}`);
  return number(id, "the text's id");
};

const number = (s: string, what: string): number => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new Failure(`${what} must be a positive integer, not ${s}`);
  return n;
};

/** Calls the API as this pane's connection; a refusal becomes a Failure with the server's message. */
function client(io: Io) {
  if (!io.pane) throw new Failure("not inside tmux: $TMUX_PANE is unset, and the server needs it to know who acts");
  const base = process.env.EDITORIAL_REVIEW_URL ?? "http://127.0.0.1:4330";
  return async (method: string, path: string, body?: unknown): Promise<unknown> => {
    let res: Response;
    try {
      res = await io.fetch(base + path, {
        method,
        headers: { "X-Tmux-Pane": io.pane!, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Failure(`no server at ${base}; start it with: proc start server -p editorial_review`);
    }
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      throw new Failure(err.message ?? `${res.status} from the server`, err.error === "NotFound" ? 2 : 1);
    }
    if (res.status === 204) return undefined;
    return res.headers.get("content-type")?.includes("json") ? res.json() : res.text();
  };
}

const actor = (a: TextState["writer"]): string => (a === "me" ? "me" : `connection ${a.connection}`);

function formatText(t: TextState): string {
  const lines = [
    `text ${t.id}: ${t.scenario}, ${t.state}, version ${t.latestVersion ?? "none yet"}`,
    `writer: ${actor(t.writer)}`,
    `waits on: ${t.waitsOn.length ? t.waitsOn.map((w) => `${actor(w.actor)} (${w.role})`).join(", ") : "nobody"}`,
  ];
  const context = Object.entries(t.context);
  if (context.length) {
    lines.push("context:");
    for (const [name, value] of context) lines.push(`  ${name}:`, ...value.replace(/\n$/, "").split("\n").map((l) => `    ${l}`));
  }
  return lines.join("\n") + "\n";
}

/** The draft with line numbers, each thread under its line and the whole-draft threads first. */
function formatDraft(t: TextState, d: Draft): string {
  const out = [`text ${t.id}, version ${d.version} (${d.origin}), ${t.state}`];
  const threadLines = (threads: Draft["threads"], indent: string) =>
    threads.flatMap((th) => th.comments.map((c) => `${indent}${c.parentId === null ? "" : "  "}[c${c.id} ${c.author}] ${c.content.replace(/\n/g, " / ")}`));
  const whole = d.threads.filter((th) => th.line === null);
  if (whole.length) out.push("on the whole draft:", ...threadLines(whole, "  "));
  const lines = d.content.split("\n");
  const width = String(lines.length).length;
  lines.forEach((line, i) => {
    out.push(`${String(i + 1).padStart(width)}  ${line}`);
    out.push(...threadLines(d.threads.filter((th) => th.line === i + 1), " ".repeat(width + 4)));
  });
  return out.join("\n") + "\n";
}
