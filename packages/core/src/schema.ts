// The record of every text, its drafts, reviews and comments. Nothing derived is
// stored: the latest version, the state and who a text waits on are the views.
//
// An actor is me or a connection. Wherever a column names one, NULL is me.

export const schema = `
CREATE TABLE IF NOT EXISTS connection (
  id      INTEGER PRIMARY KEY,
  target  TEXT NOT NULL UNIQUE,   -- tmux window id, such as @12
  label   TEXT NOT NULL           -- defaults to session:window
);

CREATE TABLE IF NOT EXISTS text (
  id                   INTEGER PRIMARY KEY,
  scenario             TEXT NOT NULL,
  context              TEXT NOT NULL DEFAULT '{}',  -- JSON object, item name to content
  writer_connection_id INTEGER REFERENCES connection(id),
  approved_draft_id    INTEGER REFERENCES draft(id),
  opened_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS draft (
  id          INTEGER PRIMARY KEY,
  text_id     INTEGER NOT NULL REFERENCES text(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('submitted', 'amended')),
  content     TEXT NOT NULL,      -- review form: one sentence per line
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (text_id, version)
);

CREATE TABLE IF NOT EXISTS review (
  id                     INTEGER PRIMARY KEY,
  draft_id               INTEGER NOT NULL REFERENCES draft(id) ON DELETE CASCADE,
  reviewer_connection_id INTEGER REFERENCES connection(id),
  started_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  submitted_at           TEXT
);

-- One review per reviewer and draft. Mine is recorded when I submit it; a
-- requested one is open from the request. NULLs are distinct to UNIQUE, so
-- mine is indexed on its own.
CREATE UNIQUE INDEX IF NOT EXISTS review_once
  ON review (draft_id, reviewer_connection_id);
CREATE UNIQUE INDEX IF NOT EXISTS review_once_mine
  ON review (draft_id) WHERE reviewer_connection_id IS NULL;

CREATE TABLE IF NOT EXISTS comment (
  id          INTEGER PRIMARY KEY,
  draft_id    INTEGER NOT NULL REFERENCES draft(id) ON DELETE CASCADE,
  author      TEXT NOT NULL,      -- a label: miki, writer, reviewer-fable
  parent_id   INTEGER REFERENCES comment(id) ON DELETE CASCADE,
  line        INTEGER,            -- NULL on the whole draft; a reply carries none
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (parent_id IS NULL OR line IS NULL)
);

-- The current draft of each text that has one.
CREATE VIEW IF NOT EXISTS latest_draft AS
SELECT d.*
FROM draft d
WHERE d.version = (SELECT MAX(version) FROM draft WHERE text_id = d.text_id);

-- One row per text: its latest version and its state.
--   approved   it points to an approved draft
--   in review  it has a draft, and I have not submitted my review of the
--              latest one, or a requested review of it is still open
--   drafting   otherwise: before the first draft, and after I submit my review
CREATE VIEW IF NOT EXISTS text_state AS
SELECT t.id AS text_id,
       t.scenario,
       t.writer_connection_id,
       t.approved_draft_id,
       l.id AS latest_draft_id,
       l.version AS latest_version,
       CASE
         WHEN t.approved_draft_id IS NOT NULL THEN 'approved'
         WHEN l.id IS NULL THEN 'drafting'
         WHEN EXISTS (SELECT 1 FROM review r
                      WHERE r.draft_id = l.id AND r.submitted_at IS NULL) THEN 'in review'
         WHEN EXISTS (SELECT 1 FROM review r
                      WHERE r.draft_id = l.id AND r.reviewer_connection_id IS NULL
                        AND r.submitted_at IS NOT NULL) THEN 'drafting'
         ELSE 'in review'
       END AS state
FROM text t
LEFT JOIN latest_draft l ON l.text_id = t.id;

-- Who each text waits on: the writer while drafting; while in review, me until
-- I submit my review, and every requested reviewer whose review is open;
-- nobody once approved. NULL is me.
CREATE VIEW IF NOT EXISTS text_waits_on AS
SELECT s.text_id, s.writer_connection_id AS connection_id, 'writer' AS role
FROM text_state s
WHERE s.state = 'drafting'
UNION ALL
SELECT s.text_id, NULL, 'reviewer'
FROM text_state s
WHERE s.state = 'in review'
  AND NOT EXISTS (SELECT 1 FROM review r
                  WHERE r.draft_id = s.latest_draft_id AND r.reviewer_connection_id IS NULL
                    AND r.submitted_at IS NOT NULL)
UNION ALL
SELECT s.text_id, r.reviewer_connection_id, 'reviewer'
FROM text_state s
JOIN review r ON r.draft_id = s.latest_draft_id AND r.submitted_at IS NULL
WHERE s.state = 'in review' AND r.reviewer_connection_id IS NOT NULL;
`;
