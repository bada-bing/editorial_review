import type { Draft, TextState } from "@editorial-review/core";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { html } from "hono/html";
import { type Candidate, type Participant, commentForm, contextWidget, editForm, exampleView, guidelinesWidget, openTexts, page, sameActor, textPanel, versionsWidget } from "./templates.ts";

/** Calls the server's API as me, the way the page does; the page never reaches core directly. */
export type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

interface ConnectionRow {
  id: string;
  target: string;
  label: string;
  state: "busy" | "waiting" | "idle" | "gone";
  pending: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ASSETS: Record<string, { path: string; type: string }> = {
  "style.css": { path: join(here, "style.css"), type: "text/css" },
  "htmx.min.js": { path: require.resolve("htmx.org/dist/htmx.min.js"), type: "text/javascript" },
  "sse.min.js": { path: require.resolve("htmx-ext-sse/dist/sse.min.js"), type: "text/javascript" },
};

class ApiError extends Error {}

/** The page and its fragments, every action going through the API. */
export function createUi(call: Call): Hono {
  const ui = new Hono();

  const json = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await call(method, path, body);
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { message?: string };
      throw new ApiError(err.message ?? `${res.status} from the API`);
    }
    return res.headers.get("content-type")?.includes("json") ? ((await res.json()) as T) : (undefined as T);
  };

  const texts = () => json<TextState[]>("GET", "/api/texts");
  const text = (id: string) => json<TextState>("GET", `/api/texts/${id}`);
  const connections = () => json<ConnectionRow[]>("GET", "/api/connections");
  const labelsOf = (rows: ConnectionRow[]) => new Map(rows.map((r) => [r.id, r.label]));
  const draftOf = async (t: TextState): Promise<Draft | undefined> =>
    t.latestVersion === null ? undefined : json<Draft>("GET", `/api/texts/${t.id}/drafts/latest`);

  const panel = async (id: string, error?: string) => {
    const [t, open, rows, windows] = await Promise.all([text(id), texts(), connections(), json<{ id: string; name: string }[]>("GET", "/api/windows")]);
    const draft = await draftOf(t);
    const outputRes = draft ? await call("GET", `/api/texts/${id}/drafts/latest/output`) : undefined;
    const output = outputRes?.ok ? await outputRes.text() : undefined;
    const labels = labelsOf(rows);
    const participants: Participant[] = [];
    const add = (actor: TextState["writer"], role: Participant["role"]) => {
      if (participants.some((p) => sameActor(p.actor, actor))) return;
      const waitedOn = t.waitsOn.some((w) => sameActor(w.actor, actor));
      const done = t.reviews.some((r) => sameActor(r.actor, actor) && r.submitted);
      if (actor === "me") participants.push({ actor, label: "you", state: "you", role: role === "writer" ? "writer" : "reviewer", waitedOn, done });
      else {
        const row = rows.find((r) => r.id === actor.connection);
        participants.push({ actor, label: row?.label ?? `connection ${actor.connection}`, state: row?.state ?? "gone", role, waitedOn, done, ...(row?.pending ? { pending: row.pending } : {}) });
      }
    };
    add(t.writer, "writer");
    if (t.writer !== "me") add("me", "reviewer");
    // Every reviewer of the current draft, the ones still reviewing and the ones done.
    for (const r of t.reviews) add(r.actor, "reviewer");
    for (const w of t.waitsOn) if (w.role === "reviewer") add(w.actor, "reviewer");
    const candidates: Candidate[] = [
      ...rows.filter((r) => !sameActor({ connection: r.id }, t.writer) && r.state !== "gone").map((r) => ({ value: `c:${r.id}`, label: r.label })),
      ...windows.map((w) => ({ value: `w:${w.id}`, label: `${w.name} (new)` })),
    ];
    const index = open.findIndex((o) => o.id === id);
    const position = {
      index: index < 0 ? 0 : index + 1,
      total: open.length,
      ...(index > 0 ? { prev: open[index - 1]!.id } : {}),
      ...(index >= 0 && index < open.length - 1 ? { next: open[index + 1]!.id } : {}),
    };
    return textPanel(t, draft, output, participants, candidates, position, labels, error);
  };

  /** An action as me, answered with the refreshed panel, or the panel with the refusal shown. */
  const act = (id: string, run: () => Promise<unknown>) => async () => {
    try {
      await run();
      return panel(id);
    } catch (e) {
      if (e instanceof ApiError) return panel(id, e.message);
      throw e;
    }
  };

  const shell = async (textId: string | undefined) => {
    const [scenarios, rows] = await Promise.all([json<string[]>("GET", "/api/scenarios"), connections()]);
    return page(
      textId,
      scenarios.map((s) => ({ value: s, label: s })),
      [{ value: "me", label: "me" }, ...rows.filter((r) => r.state !== "gone").map((r) => ({ value: r.id, label: r.label }))],
    );
  };

  ui.get("/", async (c) => {
    const open = await texts();
    return open.length ? c.redirect(`/t/${open[0]!.id}`) : c.html(await shell(undefined));
  });
  ui.get("/t/:id", async (c) => c.html(await shell(c.req.param("id"))));

  ui.get("/assets/:name", (c) => {
    const asset = ASSETS[c.req.param("name")];
    if (!asset) return c.notFound();
    return c.body(readFileSync(asset.path), 200, { "content-type": asset.type, "cache-control": "no-cache" });
  });

  ui.get("/ui/empty", (c) => c.html(""));

  ui.get("/ui/texts", async (c) => {
    const current = c.req.query("current");
    return c.html(openTexts(await texts(), labelsOf(await connections()), current || undefined));
  });

  ui.post("/ui/texts", async (c) => {
    const form = await c.req.parseBody();
    const writer = form["writer"] === "me" ? "me" : String(form["writer"]);
    const intent = String(form["intent"] ?? "").trim();
    const { id } = await json<{ id: number }>("POST", "/api/texts", { scenario: form["scenario"], writer, context: intent ? { intent } : {} });
    return c.body(null, 200, { "HX-Redirect": `/t/${id}` });
  });

  ui.get("/ui/texts/:id", async (c) => {
    try {
      return c.html(await panel(c.req.param("id")));
    } catch (e) {
      if (e instanceof ApiError) return c.html(html`<div class="empty">${e.message}. <a href="/">The open texts</a>.</div>`);
      throw e;
    }
  });
  ui.get("/ui/texts/:id/context", async (c) => c.html(contextWidget(await text(c.req.param("id")))));

  ui.get("/ui/texts/:id/versions", async (c) => {
    const id = c.req.param("id");
    return c.html(versionsWidget(id, await json("GET", `/api/texts/${id}/drafts`), undefined));
  });
  ui.get("/ui/texts/:id/versions/:v", async (c) => {
    const id = c.req.param("id");
    const v = Number(c.req.param("v"));
    const [drafts, shown] = await Promise.all([
      json<{ version: number; origin: string; createdAt: string }[]>("GET", `/api/texts/${id}/drafts`),
      json<Draft>("GET", `/api/texts/${id}/drafts/${v}`),
    ]);
    return c.html(versionsWidget(id, drafts, shown));
  });

  // The output the current version would produce, as get-result prints it.
  ui.get("/ui/texts/:id/preview", async (c) => {
    const res = await call("GET", `/api/texts/${c.req.param("id")}/drafts/latest/output`);
    return c.html(res.ok ? html`${await res.text()}` : html`<span class="muted">no draft yet</span>`);
  });

  ui.get("/ui/texts/:id/guidelines", async (c) => {
    const t = await text(c.req.param("id"));
    const s = await json<{ spec: string }>("GET", `/api/scenarios/${t.scenario}`);
    return c.html(guidelinesWidget(t.scenario, s.spec, undefined));
  });
  ui.get("/ui/scenarios/:name/examples/:eid", async (c) => {
    const s = await json<{ examples: Record<string, string> }>("GET", `/api/scenarios/${c.req.param("name")}`);
    const body = s.examples[c.req.param("eid")];
    return c.html(body === undefined ? "" : exampleView({ id: c.req.param("eid"), body }));
  });

  ui.get("/ui/texts/:id/comment-form", (c) => {
    const lineId = c.req.query("lineId");
    const replyTo = c.req.query("replyTo");
    return c.html(commentForm(c.req.param("id"), lineId || undefined, replyTo || undefined));
  });
  ui.get("/ui/texts/:id/lines/:lineId/edit", async (c) => {
    const id = c.req.param("id");
    const lineId = c.req.param("lineId");
    const draft = await json<Draft>("GET", `/api/texts/${id}/drafts/latest`);
    return c.html(editForm(id, lineId, draft.rows.find((r) => r.id === lineId)?.text ?? ""));
  });

  const idOf = (c: { req: { param: (k: string) => string } }) => c.req.param("id");
  const form = async (c: { req: { parseBody: () => Promise<Record<string, unknown>> } }) => c.req.parseBody();

  ui.post("/ui/texts/:id/comments", async (c) => {
    const id = idOf(c);
    const f = await form(c);
    const body = {
      author: "miki",
      content: String(f["content"] ?? ""),
      ...(f["lineId"] ? { lineId: String(f["lineId"]) } : {}),
      ...(f["replyTo"] ? { replyTo: String(f["replyTo"]) } : {}),
    };
    return c.html(await act(id, () => json("POST", `/api/texts/${id}/comments`, body))());
  });
  ui.post("/ui/texts/:id/lines/:lineId", async (c) => {
    const id = idOf(c);
    const f = await form(c);
    // An empty textarea removes the line; otherwise each line of it replaces the one.
    const raw = String(f["lines"] ?? "").replace(/\r/g, "").trim();
    const lines = raw === "" ? [] : raw.split("\n");
    return c.html(await act(id, () => json("POST", `/api/texts/${id}/lines/${c.req.param("lineId")}`, { lines }))());
  });
  ui.post("/ui/texts/:id/drafts", async (c) => {
    const id = idOf(c);
    const f = await form(c);
    return c.html(await act(id, () => json("POST", `/api/texts/${id}/drafts`, { text: String(f["text"] ?? "").replace(/\r/g, "") }))());
  });
  ui.post("/ui/texts/:id/ask", async (c) => {
    const id = idOf(c);
    const f = await form(c);
    return c.html(await act(id, () => json("POST", `/api/texts/${id}/ask`, { commentId: String(f["commentId"]) }))());
  });
  ui.post("/ui/texts/:id/approve", async (c) => {
    const id = idOf(c);
    return c.html(await act(id, () => json("POST", `/api/texts/${id}/approve`))());
  });
  ui.post("/ui/texts/:id/reviews/submit", async (c) => {
    const id = idOf(c);
    return c.html(await act(id, () => json("POST", `/api/texts/${id}/reviews/submit`))());
  });
  ui.post("/ui/texts/:id/reviews", async (c) => {
    const id = idOf(c);
    const f = await form(c);
    const pick = String(f["reviewer"] ?? "");
    return c.html(
      await act(id, async () => {
        let reviewer: string;
        if (pick.startsWith("w:")) reviewer = (await json<{ id: string }>("POST", `/api/windows/${encodeURIComponent(pick.slice(2))}/connect`)).id;
        else reviewer = pick.slice(2);
        await json("POST", `/api/texts/${id}/reviews`, { reviewer });
      })(),
    );
  });
  ui.delete("/ui/texts/:id", async (c) => {
    await json("DELETE", `/api/texts/${idOf(c)}`);
    return c.body(null, 200, { "HX-Redirect": "/" });
  });

  return ui;
}
