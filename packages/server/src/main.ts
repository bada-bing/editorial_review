import { serve } from "@hono/node-server";
import { Hono } from "hono";

const HOST = "127.0.0.1";
const PORT = Number(process.env.EDITORIAL_REVIEW_PORT ?? 4330);

const app = new Hono();
app.get("/", (c) => c.text("editorial_review"));

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, () => {
  console.log(`listening on http://${HOST}:${PORT}`);
});
