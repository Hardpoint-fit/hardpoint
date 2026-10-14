-- The fits database. Every statement is idempotent: migrate.mjs runs this file at every container start.
-- fits and the votes, comments and reports around them are the authority. fit_evaluations is a derived
-- cache of what the engine said about a fit's stored JSON on one build; it can be dropped and rebuilt.

CREATE TABLE IF NOT EXISTS schema_version (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fits (
  id text PRIMARY KEY CHECK (id ~ '^[0-9A-Za-z]{10}$'),
  author_user_id text NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 10000),
  hull_item text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  fit jsonb NOT NULL,
  created_build_sha text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'hidden')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CHECK (status = 'draft' OR published_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS fits_published_idx ON fits (published_at DESC, id DESC) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS fits_author_idx ON fits (author_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS fits_hull_idx ON fits (hull_item) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS fits_tags_idx ON fits USING gin (tags);

CREATE TABLE IF NOT EXISTS fit_evaluations (
  fit_id text NOT NULL REFERENCES fits (id) ON DELETE CASCADE,
  build_sha text NOT NULL,
  valid boolean NOT NULL,
  rating double precision,
  stats jsonb NOT NULL DEFAULT '{}',
  issues jsonb NOT NULL DEFAULT '[]',
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fit_id, build_sha)
);

CREATE INDEX IF NOT EXISTS fit_evaluations_build_idx ON fit_evaluations (build_sha, valid);

-- Counts are computed from these rows; there is no stored score.
CREATE TABLE IF NOT EXISTS fit_votes (
  fit_id text NOT NULL REFERENCES fits (id) ON DELETE CASCADE,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fit_id, user_id)
);

CREATE INDEX IF NOT EXISTS fit_votes_recent_idx ON fit_votes (created_at DESC, fit_id);

CREATE TABLE IF NOT EXISTS fit_comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fit_id text NOT NULL REFERENCES fits (id) ON DELETE CASCADE,
  -- One level of replies: null for a top-level comment, else a top-level comment of the same fit.
  parent_id bigint REFERENCES fit_comments (id) ON DELETE CASCADE,
  author_user_id text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  hidden boolean NOT NULL DEFAULT false
);

-- A comment its author deleted while replies still hang under it stays as a tombstone: deleted_at is the
-- authority, and body holds the fixed placeholder '[deleted]' so the 1-2000 CHECK above keeps holding
-- without relaxing it. Readers render a deleted comment from deleted_at and never show its body.
ALTER TABLE fit_comments ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS fit_comments_fit_idx ON fit_comments (fit_id, created_at, id);
CREATE INDEX IF NOT EXISTS fit_comments_parent_idx ON fit_comments (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS fit_reports (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_kind text NOT NULL CHECK (target_kind IN ('fit', 'comment')),
  -- A fit id or a comment id, as text. Not a foreign key: it points at either table.
  target_id text NOT NULL,
  reporter_user_id text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- One open report per reporter and target; a resolved one doesn't block a new report.
CREATE UNIQUE INDEX IF NOT EXISTS fit_reports_one_open_idx
  ON fit_reports (reporter_user_id, target_kind, target_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS fit_reports_open_idx ON fit_reports (created_at, id) WHERE resolved_at IS NULL;

-- Per-user write budgets (write-limits.ts): one counter per user, budget and fixed window. A user's
-- ended windows are deleted when they next write; nothing else reads this table.
CREATE TABLE IF NOT EXISTS write_budget_windows (
  user_id text NOT NULL,
  budget text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  used integer NOT NULL CHECK (used > 0),
  PRIMARY KEY (user_id, budget, window_start)
);

-- Pilots: the one owner of a pilot's display name, avatar and bio. A row is upserted at every sign-in
-- (name from the session, avatar from Clerk's `picture`), and a write by a signed-in pilot without one
-- (a session issued before this table existed) creates it from the session name (queries.ts ensurePilot).
-- Fits and comments name their author only by user id and join here to read the name.
CREATE TABLE IF NOT EXISTS pilots (
  user_id text PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) >= 1),
  avatar_url text CHECK (avatar_url ~ '^https://'),
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Before schema 4 the name was copied onto every fit and comment at write time. Backfill each writer's
-- most recent copy, then drop the copies below. Guarded so it (and its lock) runs only while those columns exist: once
-- they are dropped this block finds nothing to read and does nothing.
DO $$
DECLARE
  sources text[] := '{}';
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'fits' AND column_name = 'author_name') THEN
    sources := sources || 'SELECT author_user_id, author_name, created_at FROM fits'::text;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'fit_comments' AND column_name = 'author_name') THEN
    sources := sources || 'SELECT author_user_id, author_name, created_at FROM fit_comments'::text;
  END IF;
  IF cardinality(sources) > 0 THEN
    -- A site still running the old code keeps writing names onto rows while this runs. Hold its writes
    -- (reads go on) until this transaction commits, so no author without a pilot row lands between the
    -- backfill and the foreign keys below. Taken only while the copies exist: later starts lock nothing.
    LOCK TABLE fits, fit_comments IN SHARE ROW EXCLUSIVE MODE;
    EXECUTE format(
      'INSERT INTO pilots (user_id, name)
       SELECT DISTINCT ON (user_id) user_id, COALESCE(NULLIF(btrim(name), ''''), ''PILOT'')
       FROM (%s) AS written (user_id, name, at)
       ORDER BY user_id, at DESC, name
       ON CONFLICT (user_id) DO NOTHING',
      array_to_string(sources, ' UNION ALL '));
  END IF;
END $$;

-- Every author has a pilot row (the backfill above, then ensurePilot inside each write).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fits_author_pilot_fk') THEN
    ALTER TABLE fits ADD CONSTRAINT fits_author_pilot_fk FOREIGN KEY (author_user_id) REFERENCES pilots (user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fit_comments_author_pilot_fk') THEN
    ALTER TABLE fit_comments ADD CONSTRAINT fit_comments_author_pilot_fk FOREIGN KEY (author_user_id) REFERENCES pilots (user_id);
  END IF;
END $$;

ALTER TABLE fits DROP COLUMN IF EXISTS author_name;
ALTER TABLE fit_comments DROP COLUMN IF EXISTS author_name;

-- Who follows whom. Counts are computed from these rows.
CREATE TABLE IF NOT EXISTS pilot_follows (
  follower_user_id text NOT NULL REFERENCES pilots (user_id) ON DELETE CASCADE,
  followee_user_id text NOT NULL REFERENCES pilots (user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_user_id, followee_user_id),
  CHECK (follower_user_id <> followee_user_id)
);

CREATE INDEX IF NOT EXISTS pilot_follows_followee_idx ON pilot_follows (followee_user_id);

-- A fit's history: one row per publication and per save of an already published fit (revisions.ts), written
-- in the same transaction as the change it records. These rows are the authority for what a past revision
-- held; the fit row stays the authority for the current content. Never backfilled: a fit published before
-- this table has no history until its next publish or save.
CREATE TABLE IF NOT EXISTS fit_revisions (
  fit_id text NOT NULL REFERENCES fits (id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  title text NOT NULL,
  description text NOT NULL,
  tags text[] NOT NULL,
  hull_item text NOT NULL,
  fit jsonb NOT NULL,
  -- The engine build the content was checked against when it was written.
  build_sha text NOT NULL,
  -- The author's "what changed?", trimmed; null when they wrote none.
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fit_id, revision)
);

-- Module search: `fit @> '{"modules":[{"item":{"def":"<def>"}}]}'`. The fit JSON stays the only owner of which
-- modules a fit carries; this index only speeds up reading it.
CREATE INDEX IF NOT EXISTS fits_fit_modules_idx ON fits USING gin (fit jsonb_path_ops);

-- Text search (ILIKE on title, description and pilot name) uses trigram indexes when the server has pg_trgm
-- (Railway's Postgres does). Where the extension isn't installed or can't be created, the search still works,
-- just without the indexes, so the schema never requires it.
DO $trgm$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS fits_title_trgm_idx ON fits USING gin (title gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS fits_description_trgm_idx ON fits USING gin (description gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS pilots_name_trgm_idx ON pilots USING gin (name gin_trgm_ops);
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- The extension and its indexes are optional: nothing here may abort the migration.
  RAISE NOTICE 'pg_trgm indexes skipped (SQLSTATE %): text search runs without trigram indexes', SQLSTATE;
END
$trgm$;

INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;
INSERT INTO schema_version (version) VALUES (2) ON CONFLICT DO NOTHING;
INSERT INTO schema_version (version) VALUES (3) ON CONFLICT DO NOTHING;
INSERT INTO schema_version (version) VALUES (4) ON CONFLICT DO NOTHING;
INSERT INTO schema_version (version) VALUES (5) ON CONFLICT DO NOTHING;
INSERT INTO schema_version (version) VALUES (6) ON CONFLICT DO NOTHING;
