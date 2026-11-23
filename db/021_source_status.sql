-- Whether each source a series depends on is answering at all.
--
-- A source whose host has gone failed one series at a time and said so nowhere. Bbato
-- moved domains and its search started returning nothing: every scan logged seven lines
-- of "does not return /manga/..." among the rest, checked 38 of 53 series, and carried
-- on. Six hosts were dead that way before anyone noticed, holding fourteen series.
--
-- One row per source, written by the hourly probe. failures counts consecutive failed
-- probes, so one bad minute does not page anyone. alerted_at is the transition flag, the
-- same shape as the stall alert: it pings once when a host goes and once when it comes
-- back, never on every check in between.
CREATE TABLE source_status (
    source_id    text PRIMARY KEY,
    source_name  text        NOT NULL,
    failures     integer     NOT NULL DEFAULT 0,
    down_since   timestamptz,
    alerted_at   timestamptz,
    last_error   text,
    checked_at   timestamptz
);
