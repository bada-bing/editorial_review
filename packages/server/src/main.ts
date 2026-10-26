import { serve } from "@hono/node-server";
import { Core, openDatabase } from "@editorial-review/core";
import { Hono } from "hono";
import { homedir } from "node:os";
import { join } from "node:path";
import { createApi } from "./api.ts";
import { Connections } from "./connections.ts";
import { Scenarios } from "./scenarios.ts";
import { realTmux } from "./tmux.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.EDITORIAL_REVIEW_PORT ?? 4330);

// EDITORIAL_REVIEW_DB names the database file; the default is the XDG data directory.
const DB_PATH =
  process.env.EDITORIAL_REVIEW_DB ??
  join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "editorial_review", "editorial.db");

// EDITORIAL_REVIEW_SCENARIOS is the folder holding one folder per scenario.
const SCENARIOS = process.env.EDITORIAL_REVIEW_SCENARIOS ?? join(process.cwd(), "scenarios");

const db = openDatabase(DB_PATH);
const core = new Core(db);
const scenarios = new Scenarios(SCENARIOS);

// EDITORIAL_REVIEW_AGENTS lists the commands that count as an agent running in a tmux pane.
const AGENTS = (process.env.EDITORIAL_REVIEW_AGENTS ?? "claude").split(",").map((s) => s.trim());

const connections = new Connections(core, realTmux(AGENTS));

const app = new Hono();
app.get("/", (c) => c.text("editorial_review"));
app.route("/api", createApi(core, connections, scenarios));

serve({ fetch: app.fetch, hostname: HOST, port: PORT }, () => {
  console.log(`listening on http://${HOST}:${PORT}, database ${DB_PATH}, scenarios ${SCENARIOS}`);
});

process.on("SIGTERM", () => { db.close(); process.exit(0); });
