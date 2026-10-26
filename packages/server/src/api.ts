import { CoreError, type Actor, type Core } from "@editorial-review/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Connections } from "./connections.ts";
import type { Events } from "./events.ts";
import type { Prompts } from "./prompts.ts";
import type { Scenarios } from "./scenarios.ts";

type Env = { Variables: { actor: Actor; label: string } };

const STATUS: Record<string, ContentfulStatusCode> = {
  NotFound: 404,
  Forbidden: 403,
  Invalid: 400,
  NotYourTurn: 409,
  TextApproved: 409,
  ReviewRunning: 409,
  NotApproved: 409,
};

const id = (s: string): number => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new CoreError("Invalid", `${s} is not an id`);
  return n;
};

const parseActor = (v: unknown, fallback: Actor): Actor => {
  if (v === undefined) return fallback;
  if (v === "me") return "me";
  if (typeof v === "number" && Number.isInteger(v)) return { connection: v };
  throw new CoreError("Invalid", "writer is \"me\" or a connection id");
};

/**
 * The JSON API over every action of core. A request carrying X-Tmux-Pane acts
 * as that pane's connection; one without acts as me.
 */
export function createApi(core: Core, connections: Connections, scenarios: Scenarios, prompts: Prompts, events: Events): Hono<Env> {
  const api = new Hono<Env>();

  const changed = (textId: number) => {
    const t = core.getText(textId);
    events.publish({ event: "text", data: { id: textId, state: t.state, latestVersion: t.latestVersion } });
  };

  api.use("*", async (c, next) => {
    const pane = c.req.header("X-Tmux-Pane");
    if (pane) {
      const conn = await connections.fromPane(pane);
      c.set("actor", { connection: conn.id });
      c.set("label", conn.label);
    } else {
      c.set("actor", "me");
      c.set("label", "me");
    }
    await next();
  });

  api.onError((err, c) => {
    if (err instanceof CoreError) return c.json({ error: err.code, message: err.message }, STATUS[err.code] ?? 500);
    if (err instanceof SyntaxError) return c.json({ error: "Invalid", message: "the body is not JSON" }, 400);
    console.error(err);
    return c.json({ error: "Internal", message: String(err) }, 500);
  });

  api.get("/texts", (c) => c.json(core.listOpenTexts()));

  api.post("/texts", async (c) => {
    const body = (await c.req.json()) as { scenario?: string; writer?: unknown; context?: Record<string, string> };
    if (!body.scenario) throw new CoreError("Invalid", "scenario is required");
    if (!scenarios.has(body.scenario)) throw new CoreError("NotFound", `no scenario named ${body.scenario}`);
    const actor = c.get("actor");
    const textId = core.openText(actor, body.scenario, parseActor(body.writer, actor), body.context ?? {});
    prompts.draft(textId);
    changed(textId);
    return c.json({ id: textId }, 201);
  });

  api.get("/texts/:id", (c) => c.json(core.getText(id(c.req.param("id")))));

  api.delete("/texts/:id", (c) => {
    if (c.get("actor") === "me") prompts.dropped(id(c.req.param("id")));
    core.drop(c.get("actor"), id(c.req.param("id")));
    events.publish({ event: "text", data: { id: id(c.req.param("id")), dropped: true } });
    return c.body(null, 204);
  });

  api.get("/texts/:id/drafts/:version", (c) => {
    const v = c.req.param("version");
    return c.json(core.getDraft(id(c.req.param("id")), v === "latest" ? undefined : id(v)));
  });

  api.post("/texts/:id/drafts", async (c) => {
    const { content } = (await c.req.json()) as { content?: string };
    if (typeof content !== "string") throw new CoreError("Invalid", "content is required");
    const version = core.submitDraft(c.get("actor"), id(c.req.param("id")), content);
    changed(id(c.req.param("id")));
    return c.json({ version }, 201);
  });

  api.post("/texts/:id/amendments", async (c) => {
    const { line, lines } = (await c.req.json()) as { line?: number; lines?: string[] };
    if (!Number.isInteger(line) || !Array.isArray(lines)) throw new CoreError("Invalid", "line and lines are required");
    const version = core.amendDraft(c.get("actor"), id(c.req.param("id")), line!, lines);
    changed(id(c.req.param("id")));
    return c.json({ version }, 201);
  });

  api.post("/texts/:id/comments", async (c) => {
    const body = (await c.req.json()) as { author?: string; content?: string; line?: number; replyTo?: number };
    if (typeof body.content !== "string") throw new CoreError("Invalid", "content is required");
    const commentId = core.addComment(c.get("actor"), id(c.req.param("id")), {
      author: body.author ?? c.get("label"),
      content: body.content,
      ...(body.line !== undefined ? { line: body.line } : {}),
      ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
    });
    changed(id(c.req.param("id")));
    return c.json({ id: commentId }, 201);
  });

  api.post("/texts/:id/reviews", async (c) => {
    const { reviewer } = (await c.req.json()) as { reviewer?: number };
    if (!Number.isInteger(reviewer)) throw new CoreError("Invalid", "reviewer is a connection id");
    const reviewId = core.requestReview(c.get("actor"), id(c.req.param("id")), reviewer!);
    prompts.review(id(c.req.param("id")), reviewer!);
    changed(id(c.req.param("id")));
    return c.json({ id: reviewId }, 201);
  });

  api.post("/texts/:id/reviews/submit", (c) => {
    core.submitReview(c.get("actor"), id(c.req.param("id")));
    prompts.redraft(id(c.req.param("id")));
    changed(id(c.req.param("id")));
    return c.body(null, 204);
  });

  api.post("/texts/:id/approve", (c) => {
    core.approve(c.get("actor"), id(c.req.param("id")));
    prompts.result(id(c.req.param("id")));
    changed(id(c.req.param("id")));
    return c.body(null, 204);
  });

  api.get("/texts/:id/result", (c) => c.text(core.getResult(id(c.req.param("id")))));

  // Ask: one thread sent to the writer, who answers with a reply in it.
  api.post("/texts/:id/ask", async (c) => {
    if (c.get("actor") !== "me") throw new CoreError("Forbidden", "an agent may not ask the writer");
    const { commentId } = (await c.req.json()) as { commentId?: number };
    if (!Number.isInteger(commentId)) throw new CoreError("Invalid", "commentId is required");
    const t = core.getText(id(c.req.param("id")));
    if (t.state !== "in review") throw new CoreError("NotYourTurn", `cannot ask while the text is ${t.state}`);
    prompts.ask(t.id, commentId!);
    return c.body(null, 202);
  });

  api.get("/connections", async (c) =>
    c.json((await connections.list()).map((conn) => ({ ...conn, pending: prompts.pending(conn.id) }))),
  );

  // `editorial connect --as <label>`: the caller's window takes over that label's connection.
  api.post("/connections", async (c) => {
    const pane = c.req.header("X-Tmux-Pane");
    if (!pane) throw new CoreError("Invalid", "connecting needs the X-Tmux-Pane header");
    const { label } = (await c.req.json()) as { label?: string };
    if (!label) throw new CoreError("Invalid", "label is required");
    return c.json(await connections.reconnectAs(label, pane));
  });

  // From the UI: a connection re-established on another window, or relabelled.
  api.post("/connections/:id/target", async (c) => {
    const { target } = (await c.req.json()) as { target?: string };
    if (!target) throw new CoreError("Invalid", "target is a tmux window id");
    connections.retarget(id(c.req.param("id")), target);
    return c.body(null, 204);
  });

  api.post("/connections/:id/label", async (c) => {
    const { label } = (await c.req.json()) as { label?: string };
    if (!label) throw new CoreError("Invalid", "label is required");
    connections.relabel(id(c.req.param("id")), label);
    return c.body(null, 204);
  });

  // Windows running an agent that are not yet connections, offered as reviewers.
  api.get("/windows", async (c) => c.json(await connections.candidateWindows()));

  // A window picked as a reviewer becomes a connection.
  api.post("/windows/:id/connect", async (c) => {
    const windowId = c.req.param("id");
    const { state, name } = await connections.tmux.windowState(windowId);
    if (state === "gone" || !name) throw new CoreError("NotFound", `no agent runs in window ${windowId}`);
    return c.json(connections.forWindow({ id: windowId, name }), 201);
  });

  api.get("/scenarios", (c) => c.json(scenarios.list()));

  api.get("/scenarios/:name", (c) => {
    const s = scenarios.get(c.req.param("name"));
    if (!s) throw new CoreError("NotFound", `no scenario named ${c.req.param("name")}`);
    return c.json(s);
  });

  // The page's stream: `text` events name a text that changed, `connections`
  // carry the participants when a window's state changes. A comment line
  // every 15 seconds keeps the connection alive.
  api.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "connections", data: JSON.stringify(await connections.list()) });
      await new Promise<void>((resolve) => {
        const unsubscribe = events.subscribe((e) => {
          void stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) });
        });
        const keepAlive = setInterval(() => void stream.write(": keep-alive\n\n"), 15000);
        keepAlive.unref();
        stream.onAbort(() => {
          unsubscribe();
          clearInterval(keepAlive);
          resolve();
        });
      });
    }),
  );

  return api;
}
