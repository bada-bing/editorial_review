import { readFileSync } from "node:fs";
import { run } from "./commands.ts";

const outcome = await run(process.argv.slice(2), {
  fetch: (url, init) => fetch(url, init),
  pane: process.env.TMUX_PANE,
  stdin: () => readFileSync(0, "utf8"),
});
process.stdout.write(outcome.stdout);
process.stderr.write(outcome.stderr);
process.exitCode = outcome.code;
