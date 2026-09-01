CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'in_progress',
  agent_model       TEXT,
  agent_provider    TEXT,
  reasoning_effort  TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_agent_response_at  INTEGER,
  last_viewed_at    INTEGER,
  last_context_used_tokens   INTEGER,
  last_context_window_tokens INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

CREATE TABLE IF NOT EXISTS mission_runs (
  id                TEXT PRIMARY KEY,
  mission_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id        TEXT NOT NULL,
  session_confirmed_at INTEGER,
  attempt           INTEGER NOT NULL CHECK(attempt > 0),
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  reasoning_effort  TEXT,
  status            TEXT NOT NULL,
  started_at        INTEGER,
  last_activity_at  INTEGER NOT NULL,
  finished_at       INTEGER,
  finish_reason     TEXT,
  previous_run_id   TEXT REFERENCES mission_runs(id),
  UNIQUE(mission_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_mission_runs_session ON mission_runs(session_id);
CREATE INDEX IF NOT EXISTS idx_mission_runs_activity ON mission_runs(status, last_activity_at DESC);

CREATE TABLE IF NOT EXISTS run_events (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES mission_runs(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  occurred_at   INTEGER NOT NULL,
  payload_json  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_time ON run_events(run_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS operator_commands (
  idempotency_key  TEXT PRIMARY KEY,
  actor_id         TEXT NOT NULL,
  mission_id       TEXT NOT NULL,
  run_id           TEXT,
  command_type     TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  status           TEXT NOT NULL,
  result_json      TEXT,
  created_at       INTEGER NOT NULL,
  completed_at     INTEGER
);
