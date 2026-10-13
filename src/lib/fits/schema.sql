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
  author_name text NOT NULL,
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
  author_name text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  hidden boolean NOT NULL DEFAULT false
);

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

INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;
