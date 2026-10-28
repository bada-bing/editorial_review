import type { Actor, Draft, TextState, Thread } from "@editorial-review/core";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

export interface Participant {
  actor: Actor;
  label: string;
  state: "busy" | "waiting" | "idle" | "gone" | "you";
  role: "writer" | "reviewer" | "you";
  waitedOn: boolean;
  /** For a reviewer: its review of the current draft is submitted. */
  done?: boolean;
  pending?: number;
}

export interface Candidate {
  value: string;
  label: string;
}

export const sameActor = (a: Actor, b: Actor): boolean =>
  a === "me" ? b === "me" : b !== "me" && a.connection === b.connection;

/** The one page: the shell with the three columns, each filled by a fragment that refreshes on the stream. */
export function page(textId: string | undefined, scenarios: Candidate[], writers: Candidate[]): Html {
  const main =
    textId === undefined
      ? html`<div class="empty">No text is open. An agent opens one with <code>editorial open-text</code>, or open one here.</div>`
      : raw(`<div id="text" hx-get="/ui/texts/${textId}" hx-trigger="load, sse:text, sse:connections" hx-swap="innerHTML"></div>`);
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Editorial review</title>
<link rel="stylesheet" href="/assets/style.css" />
<script src="/assets/htmx.min.js"></script>
<script src="/assets/sse.min.js"></script>
</head>
<body hx-ext="sse" sse-connect="/api/events">
<script>
  // A dropped text leaves the page: when the stream says the text shown here is gone, go to the first open one.
  document.body.addEventListener("htmx:sseMessage", (e) => {
    if (e.detail.type !== "text") return;
    const d = JSON.parse(e.detail.data);
    if (d.dropped && location.pathname.endsWith("/" + d.id)) location.href = "/";
  });
</script>
<div class="layout">
  <aside class="column">
    <section class="widget" id="open-texts" hx-get="/ui/texts?current=${textId ?? ""}" hx-trigger="load, sse:text" hx-swap="innerHTML"></section>
    ${textId === undefined ? "" : raw(`<section class="widget" id="context" hx-get="/ui/texts/${textId}/context" hx-trigger="load" hx-swap="innerHTML"></section>`)}
    ${textId === undefined ? "" : raw(`<section class="widget" id="versions" hx-get="/ui/texts/${textId}/versions" hx-trigger="load, sse:text" hx-swap="innerHTML"></section>`)}
  </aside>
  <main>${main}</main>
</div>
<div class="below">
  ${textId === undefined ? "" : raw(`<section class="widget guidelines" id="guidelines" hx-get="/ui/texts/${textId}/guidelines" hx-trigger="load" hx-swap="innerHTML"></section>`)}
  <section class="widget" id="open-form">${openForm(scenarios, writers)}</section>
</div>
</body>
</html>`;
}

function openForm(scenarios: Candidate[], writers: Candidate[]): Html {
  return html`<h2>Open a text</h2>
<form hx-post="/ui/texts" hx-target="#text" hx-swap="innerHTML">
  <div class="row"><label>scenario <select name="scenario">${options(scenarios)}</select></label></div>
  <div class="row"><label>writer <select name="writer">${options(writers)}</select></label></div>
  <div class="row"><label>intent <textarea name="intent" rows="2"></textarea></label></div>
  <button class="primary" type="submit">Open</button>
</form>`;
}

export function options(items: Candidate[], selected?: string): Html {
  return html`${items.map((o) => html`<option value="${o.value}" ${o.value === selected ? "selected" : ""}>${o.label}</option>`)}`;
}

/** The Open texts widget: every text not yet approved, in the order opened, with the arrows' position. */
export function openTexts(texts: TextState[], labels: Map<string, string>, current: string | undefined): Html {
  const who = (t: TextState) => (t.waitsOn.length ? t.waitsOn.map((w) => actorLabel(w.actor, labels)).join(", ") : "nobody");
  return html`<h2>Open texts</h2>
${texts.length === 0 ? html`<div class="muted">none</div>` : ""}
<ul>${texts.map(
    (t) => html`<li class="${t.id === current ? "current" : ""}">
  <a href="/t/${t.id}">${t.id} · ${t.scenario}</a>
  <span class="state">${t.state}, waits on ${who(t)}</span>
</li>`,
  )}</ul>`;
}

export function actorLabel(actor: Actor, labels: Map<string, string>): string {
  return actor === "me" ? "you" : (labels.get(actor.connection) ?? `connection ${actor.connection}`);
}

/** The text panel: header with the arrows, the participants and the controls, then the draft with its threads. */
export function textPanel(t: TextState, draft: Draft | undefined, output: string | undefined, participants: Participant[], candidates: Candidate[], position: { index: number; total: number; prev?: string; next?: string }, labels: Map<string, string>, error?: string): Html {
  const inReview = t.state === "in review";
  const reviewRunning = t.waitsOn.some((w) => w.role === "reviewer" && w.actor !== "me");
  const canAct = inReview && !reviewRunning;
  const askOpen = inReview && t.waitsOn.some((w) => w.role === "writer");
  const mySubmitPending = inReview && !askOpen && t.waitsOn.some((w) => w.actor === "me" && w.role === "reviewer");
  const iWrite = t.writer === "me" && t.state === "drafting";
  return html`<div class="header">
  <h1>Text ${t.id} · ${t.scenario}</h1>
  <span class="state">${t.state}${draft ? html`, version ${draft.version} (${draft.origin})` : ""}</span>
  <span class="arrows">${position.prev === undefined ? html`<span class="muted">‹</span>` : html`<a href="/t/${position.prev}">‹</a>`}${position.index} / ${position.total}${position.next === undefined ? html`<span class="muted">›</span>` : html`<a href="/t/${position.next}">›</a>`}</span>
</div>
<div class="participants">
  <div><span class="role">writer</span> ${participantView(participants.find((p) => p.role === "writer")!)}</div>
  <div><span class="role">reviewers</span> ${(() => {
    const reviewers = participants.filter((p) => p.role !== "writer");
    return reviewers.length ? reviewers.map((p) => participantView(p)) : html`<span class="muted">none</span>`;
  })()}</div>
  <div><span class="role">waits on</span> ${t.waitsOn.length ? t.waitsOn.map((w) => actorLabel(w.actor, labels)).join(", ") : html`<span class="muted">nobody, approved</span>`}</div>
</div>
<div class="controls">
  <form hx-post="/ui/texts/${t.id}/reviews/submit" hx-target="#text"><button type="submit" ${mySubmitPending ? "" : "disabled"} title="${askOpen ? "An Ask awaits the writer's answer" : "End your review; the writer drafts again once no review is open"}">Submit review</button></form>
  <form hx-post="/ui/texts/${t.id}/approve" hx-target="#text" hx-confirm="Approve version ${draft?.version ?? "?"} as the final text?"><button class="primary" type="submit" ${canAct ? "" : "disabled"}>Approve</button></form>
  <form hx-post="/ui/texts/${t.id}/reviews" hx-target="#text">
    <label class="muted">request a review from</label>
    <select name="reviewer" ${inReview ? "" : "disabled"}>${options(candidates)}</select>
    <button type="submit" ${inReview && candidates.length ? "" : "disabled"}>Request</button>
  </form>
  <form hx-delete="/ui/texts/${t.id}" hx-target="body" hx-confirm="Drop text ${t.id} with its drafts and comments?"><button type="submit">Drop</button></form>
</div>
${error ? html`<div class="error">${error}</div>` : ""}
${iWrite ? submitDraftForm(t.id, draft ? previousAsText(draft) : undefined) : ""}
${draft ? html`<div class="split">
  ${draftView(t.id, draft, canAct, inReview)}
  <div class="output"><div class="line heading"><span class="text">output</span></div><pre id="preview">${output ?? ""}</pre></div>
</div>` : html`<div class="empty">Waiting on ${t.waitsOn.map((w) => actorLabel(w.actor, labels)).join(", ")} for the first draft.</div>`}`;
}

/** A window's state in a participant's words: busy is working, waiting and idle are ready for a prompt, gone is gone. */
const stateWord: Record<Participant["state"], string> = { busy: "working", waiting: "ready", idle: "ready", gone: "gone", you: "" };

function participantView(p: Participant): Html {
  const facts = [
    ...(p.state === "you" ? [] : [stateWord[p.state]]),
    ...(p.role === "reviewer" ? [p.done ? "review submitted" : p.waitedOn ? "reviewing" : ""] : []),
    ...(p.pending ? [`${p.pending} prompt${p.pending === 1 ? "" : "s"} pending`] : []),
  ].filter(Boolean);
  return html`<span class="participant ${p.role === "you" ? "you" : ""}">${p.label}${facts.length ? html` <span class="state ${p.state}">${facts.join(", ")}</span>` : ""}</span>`;
}

function submitDraftForm(id: string, previous: string | undefined): Html {
  return html`<form class="inline-form" style="margin-left:0" hx-post="/ui/texts/${id}/drafts" hx-target="#text">
  <label>${previous ? "Your next version" : "Your draft"}: one sentence per line, an empty line between paragraphs, a bullet starting with "- "
  <textarea name="text" rows="8">${previous ?? ""}</textarea></label>
  <div class="row"><button class="primary" type="submit">Submit draft</button></div>
</form>`;
}

/** The last version as text for the textarea: its rows, a bullet's first line marked, so retyping keeps the ids. */
function previousAsText(draft: Draft): string {
  const out: string[] = [];
  let lastPath = "";
  for (const r of draft.rows) {
    const bullet = /\/bullet\[\d+\]/.exec(r.path)?.[0];
    const section = r.path.replace(/\/line\[\d+\]$/, "");
    if (out.length && section.split("/")[1] !== lastPath.split("/")[1]) out.push("");
    if (bullet && section !== lastPath) out.push(`- ${r.text}`);
    else if (bullet) out.push(`  ${r.text}`);
    else out.push(r.text);
    lastPath = section;
  }
  return out.join("\n");
}

/** The draft row by row, each row a line of the tree with its threads under it; the whole-draft threads come last. */
export function draftView(id: string, draft: Draft, canAmend: boolean, canComment: boolean): Html {
  const whole = draft.threads.filter((th) => th.lineId === null);
  const onLine = (lineId: string) => draft.threads.filter((th) => th.lineId === lineId);
  let lastSection = "";
  return html`<div class="draft">
  <div class="line heading"><span class="number"></span><span class="text">draft</span><span class="marks"></span></div>
  ${draft.rows.map((r) => {
    const section = r.path.split("/")[1] ?? "";
    const gap = lastSection && section !== lastSection ? html`<div class="gap"></div>` : "";
    lastSection = section;
    const bullet = /\/bullet\[\d+\]\/line\[1\]$/.test(r.path);
    // The comment a change answers: a mark, and the comment itself in a floating box on hover.
    const answers = r.answers.map((a) => {
      const c = draft.answered[a];
      return html`<span class="answers">↩ ${c ? c.author : a}<span class="popover">${c ? html`<span class="author">${c.author}</span> ${c.content}` : html`${a} is not a comment of this text`}</span></span>`;
    });
    return html`${gap}<div class="line ${r.change} ${bullet ? "item" : ""}" id="line-${r.id}" data-line="${r.id}">
    <span class="number" title="${r.id}">${r.n}</span>
    <span class="text">${r.text}<span class="actions">
      ${canComment ? html`<button title="Comment on this line" hx-get="/ui/texts/${id}/comment-form?lineId=${r.id}" hx-target="#after-${r.id}" hx-swap="innerHTML">+</button>` : ""}
      ${canAmend ? html`<button title="Edit this line" hx-get="/ui/texts/${id}/lines/${r.id}/edit" hx-target="#after-${r.id}" hx-swap="innerHTML">✎</button>` : ""}
    </span></span>
    <span class="marks">${answers}${r.change !== "unchanged" && !r.answers.length ? html`<span class="unasked" title="a ${r.change} line that answers no comment">${r.change}</span>` : ""}</span>
  </div>
  <div id="after-${r.id}"></div>
  ${onLine(r.id).length ? html`<div class="threads">${onLine(r.id).map((th) => threadView(id, th, canComment, false))}</div>` : ""}`;
  })}
  ${draft.removed.length ? html`<div class="removed-lines"><h3>Removed since the version before</h3>${draft.removed.map((r) => html`<div class="line removed"><span class="number"></span><span class="text">${r.text}</span><span class="marks"></span></div>${onLine(r.id).length ? html`<div class="threads">${onLine(r.id).map((th) => threadView(id, th, false, false))}</div>` : ""}`)}</div>` : ""}
  <div class="whole-draft">
    <h3>On the whole draft</h3>
    <div class="threads" style="margin-left:0">
      ${whole.length ? whole.map((th) => threadView(id, th, canComment, true)) : html`<span class="muted">no comments</span>`}
    </div>
    ${canComment ? html`<div><button hx-get="/ui/texts/${id}/comment-form" hx-target="this" hx-swap="outerHTML">Comment on the whole draft</button></div>` : ""}
  </div>
</div>`;
}

function threadView(id: string, th: Thread, canComment: boolean, whole: boolean): Html {
  const first = th.comments[0]!;
  const asked = th.comments.some((c) => c.asked);
  return html`<div class="thread ${whole ? "whole" : ""} ${asked ? "asked" : ""}" id="thread-${first.id}">
  ${asked ? html`<div class="asked-mark">asked, waiting for the writer</div>` : ""}
  ${th.comments.map((c) => html`<div class="comment ${c.parentId === null ? "" : "reply"}"><span class="author">${c.author}</span><span class="body">${c.content}</span><span class="muted" title="comment id">${c.id}</span></div>`)}
  ${canComment ? html`<div class="actions">
    <button hx-get="/ui/texts/${id}/comment-form?replyTo=${th.comments.at(-1)!.id}" hx-target="this" hx-swap="outerHTML">Reply</button>
    <button hx-post="/ui/texts/${id}/ask" hx-vals='{"commentId": "${th.comments.at(-1)!.id}"}' hx-target="#text" title="Send this thread to the writer, who answers in it" ${asked ? "disabled" : ""}>Ask</button>
  </div>` : ""}
</div>`;
}

export function commentForm(id: string, lineId: string | undefined, replyTo: string | undefined): Html {
  return html`<form class="inline-form" hx-post="/ui/texts/${id}/comments" hx-target="#text">
  ${lineId !== undefined ? html`<input type="hidden" name="lineId" value="${lineId}" />` : ""}
  ${replyTo !== undefined ? html`<input type="hidden" name="replyTo" value="${replyTo}" />` : ""}
  <textarea name="content" rows="2" autofocus placeholder="${replyTo !== undefined ? "Reply" : lineId !== undefined ? "Comment on this line" : "Comment on the whole draft"}"></textarea>
  <div class="row"><button class="primary" type="submit">Comment</button><button type="button" hx-get="/ui/empty" hx-target="closest form" hx-swap="outerHTML">Cancel</button></div>
</form>`;
}

/** Editing one line: its text in a textarea; each line of the result replaces it, the first keeping the id. */
export function editForm(id: string, lineId: string, text: string): Html {
  return html`<form class="inline-form" hx-post="/ui/texts/${id}/lines/${lineId}" hx-target="#text">
  <textarea name="lines" rows="2" autofocus>${text}</textarea>
  <div class="row"><button class="primary" type="submit">Save as new version</button><button type="button" hx-get="/ui/empty" hx-target="closest form" hx-swap="outerHTML">Cancel</button><span class="muted">Several lines replace the one; an empty box removes it.</span></div>
</form>`;
}

export function contextWidget(t: TextState): Html {
  const items = Object.entries(t.context);
  return html`<h2>Context</h2>
${items.length === 0 ? html`<div class="muted">none</div>` : html`<dl class="context">${items.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`}`;
}

export function versionsWidget(id: string, drafts: { version: number; origin: string; createdAt: string }[], shown: Draft | undefined): Html {
  return html`<h2>Versions</h2>
${drafts.length === 0 ? html`<div class="muted">none yet</div>` : ""}
<ul class="versions">${drafts.map(
    (d) => html`<li><a href="#" hx-get="/ui/texts/${id}/versions/${d.version}" hx-target="#versions" hx-swap="innerHTML">v${d.version}</a> <span class="muted">${d.origin}</span>${shown?.version === d.version ? html` <span class="muted">(shown)</span>` : ""}</li>`,
  )}</ul>
${shown ? html`<div class="diff">${shown.rows.map((r) => html`<div class="${r.change}">${r.text}</div>`)}${shown.removed.map((r) => html`<div class="removed">${r.text}</div>`)}</div><div style="margin-top:6px"><button hx-get="/ui/texts/${id}/versions" hx-target="#versions" hx-swap="innerHTML">Hide</button></div>` : ""}`;
}

/** The scenario's spec, with each example id a click away. */
export function guidelinesWidget(scenario: string, spec: string, example: { id: string; body: string } | undefined): Html {
  const parts = spec.split(/\b(E\d+)\b/);
  return html`<h2>Guidelines · ${scenario}</h2>
<div class="spec">${parts.map((p, i) => (i % 2 === 1 ? html`<a class="example" href="#" hx-get="/ui/scenarios/${scenario}/examples/${p}" hx-target="#example" hx-swap="innerHTML">${p}</a>` : html`${p}`))}</div>
<div id="example">${example ? exampleView(example) : ""}</div>`;
}

export function exampleView(example: { id: string; body: string }): Html {
  return html`<div class="example-view"><strong>${example.id}</strong>
${example.body.replace(/^---\n[\s\S]*?\n---\n/, "")}</div>`;
}
