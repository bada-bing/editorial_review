import { CoreError, type Actor, type Core } from "@editorial-review/core";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Scenarios } from "./scenarios.ts";

/** Finds or creates the connection of the tmux window holding `pane`. */
export type ConnectionLookup = (pane: string) => { id: number; label: string };

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
export function createApi(core: Core, lookup: ConnectionLookup, scenarios: Scenarios): Hono<Env> {
  const api = new Hono<Env>();

  api.use("*", async (c, next) => {
    const pane = c.req.header("X-Tmux-Pane");
    if (pane) {
      const conn = lookup(pane);
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
    return c.json({ id: textId }, 201);
  });

  api.get("/texts/:id", (c) => c.json(core.getText(id(c.req.param("id")))));

  api.delete("/texts/:id", (c) => {
    core.drop(c.get("actor"), id(c.req.param("id")));
    return c.body(null, 204);
  });

  api.get("/texts/:id/drafts/:version", (c) => {
    const v = c.req.param("version");
    return c.json(core.getDraft(id(c.req.param("id")), v === "latest" ? undefined : id(v)));
  });

  api.post("/texts/:id/drafts", async (c) => {
    const { content } = (await c.req.json()) as { content?: string };
    if (typeof content !== "string") throw new CoreError("Invalid", "content is required");
    return c.json({ version: core.submitDraft(c.get("actor"), id(c.req.param("id")), content) }, 201);
  });

  api.post("/texts/:id/amendments", async (c) => {
    const { line, lines } = (await c.req.json()) as { line?: number; lines?: string[] };
    if (!Number.isInteger(line) || !Array.isArray(lines)) throw new CoreError("Invalid", "line and lines are required");
    return c.json({ version: core.amendDraft(c.get("actor"), id(c.req.param("id")), line!, lines) }, 201);
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
    return c.json({ id: commentId }, 201);
  });

  api.post("/texts/:id/reviews", async (c) => {
    const { reviewer } = (await c.req.json()) as { reviewer?: number };
    if (!Number.isInteger(reviewer)) throw new CoreError("Invalid", "reviewer is a connection id");
    return c.json({ id: core.requestReview(c.get("actor"), id(c.req.param("id")), reviewer!) }, 201);
  });

  api.post("/texts/:id/reviews/submit", (c) => {
    core.submitReview(c.get("actor"), id(c.req.param("id")));
    return c.body(null, 204);
  });

  api.post("/texts/:id/approve", (c) => {
    core.approve(c.get("actor"), id(c.req.param("id")));
    return c.body(null, 204);
  });

  api.get("/texts/:id/result", (c) => c.text(core.getResult(id(c.req.param("id")))));

  api.get("/connections", (c) => c.json(core.listConnections()));

  api.get("/scenarios", (c) => c.json(scenarios.list()));

  api.get("/scenarios/:name", (c) => {
    const s = scenarios.get(c.req.param("name"));
    if (!s) throw new CoreError("NotFound", `no scenario named ${c.req.param("name")}`);
    return c.json(s);
  });

  return api;
}
