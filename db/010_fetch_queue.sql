-- Chapters known to be missing. The ledger says what we have; this says what we want,
-- and keeps the attempt history so a source that keeps failing is visible rather than
-- silently retried forever.
CREATE TABLE wanted (
    series_id       bigint      NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    chapter_number  numeric(10,4) NOT NULL,
    binding_id      bigint      REFERENCES series_binding(id) ON DELETE CASCADE,
    state           text        NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending', 'fetching', 'done', 'failed')),
    attempts        integer     NOT NULL DEFAULT 0,
    last_error      text,
    queued_at       timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz,
    PRIMARY KEY (series_id, chapter_number)
);

CREATE INDEX wanted_pending ON wanted (state) WHERE state IN ('pending', 'failed');
