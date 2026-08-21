-- Comparison data is expensive: every row is a live round trip to a source. Caching
-- it means the review page loads instantly and reviewing does not hammer the sites.
CREATE TABLE candidate_comparison (
    candidate_id    bigint      NOT NULL REFERENCES import_candidate(id) ON DELETE CASCADE,
    manga_id        integer     NOT NULL,
    source_name     text        NOT NULL,
    source_id       text,
    source_url      text,
    chapters        integer     NOT NULL,
    range_lo        numeric(10,4),
    range_hi        numeric(10,4),
    gaps            integer     NOT NULL DEFAULT 0,
    latest          jsonb       NOT NULL DEFAULT '[]',
    note            text,
    checked_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (candidate_id, manga_id)
);
