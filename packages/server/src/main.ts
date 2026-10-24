import { serve } from "@hono/node-server";
import { openDatabase } from "@editorial-review/core";
import { Hono } from "hono";
import { homedir } from "node:os";
import { join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.EDITORIAL_REVIEW_PORT ?? 4330);

// EDITORIAL_REVIEW_DB names the database file; the default is the XDG data directory.
const DB_PATH =
  process.env.EDITORIAL_REVIEW_DB ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "editorial_review", "editorial.db");

const db = openDatabase(DB_PATH);

const app = new Hono();
app.get("/", (c) => c.text("editorial_review"));

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, () => {
  console.log(`listening on http://${HOST}:${PORT}, database ${DB_PATH}`);
});

process.on("SIGTERM", () => { db.close(); process.exit(0); });
