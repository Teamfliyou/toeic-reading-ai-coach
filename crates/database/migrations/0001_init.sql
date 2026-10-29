-- Schéma initial de la base locale Lernoviq (idempotent : IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS attempts (
    id           TEXT PRIMARY KEY NOT NULL,
    question_id  TEXT NOT NULL,
    part         INTEGER NOT NULL,
    category     TEXT,
    selected_key TEXT NOT NULL,
    correct      INTEGER NOT NULL,
    time_ms      INTEGER NOT NULL,
    at           TEXT NOT NULL,
    mode         TEXT NOT NULL,
    owner        TEXT,
    synced       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS attempts_at_idx ON attempts (at DESC);

CREATE TABLE IF NOT EXISTS review_cards (
    question_id TEXT PRIMARY KEY NOT NULL,
    part        INTEGER NOT NULL,
    box         INTEGER NOT NULL,
    due         TEXT NOT NULL,
    mastered    INTEGER NOT NULL,
    lapses      INTEGER NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vocab_words (
    id                 TEXT PRIMARY KEY NOT NULL,
    term               TEXT NOT NULL,
    meaning            TEXT NOT NULL,
    example            TEXT NOT NULL,
    source_question_id TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    box                INTEGER NOT NULL,
    due                TEXT NOT NULL,
    mastered           INTEGER NOT NULL,
    lapses             INTEGER NOT NULL,
    deleted            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS goals (
    id           INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    exam_date    TEXT,
    target_score INTEGER,
    daily_goal   INTEGER NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exam_history (
    at      TEXT PRIMARY KEY NOT NULL,
    score   INTEGER NOT NULL,
    correct INTEGER NOT NULL,
    total   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
