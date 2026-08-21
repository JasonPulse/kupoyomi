-- Kupoyomi schema.
--
-- The whole point of this design is that identity never moves. A series is an
-- opaque id; the sources it can be fetched from hang off it as bindings, and the
-- chapter ledger is keyed on chapter number alone. Migrating a series to a new
-- source adds a binding and touches no ledger row, which is what makes migration
-- cost zero bytes instead of re-downloading the series.

CREATE TABLE series (
    id              bigserial PRIMARY KEY,
    title           text        NOT NULL,
    -- Folder name under the library root. Ours, not a source's, so it is never
    -- sanitized-with-underscores the way Suwayomi's tree is.
    folder          text        NOT NULL UNIQUE,
    status          text        NOT NULL DEFAULT 'UNKNOWN',
    cover_path      text,
    -- Tracker ids are metadata and a matching aid. They are deliberately NOT the
    -- identity: plenty of titles have no tracker entry at all.
    anilist_id      integer,
    mangaupdates_id text,
    mangadex_id     text,
    -- Stall alerting fires on transition, not on state, so a quiet series pings
    -- once instead of every sweep. Muted series never ping.
    muted           boolean     NOT NULL DEFAULT false,
    stalled_since   timestamptz,
    stall_alerted_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE series_binding (
    id              bigserial PRIMARY KEY,
    series_id       bigint      NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    -- Suwayomi's source id and its display name. The name is kept so a binding is
    -- still legible after the extension is uninstalled, which is exactly the state
    -- 24 of the existing series are in.
    source_id       text        NOT NULL,
    source_name     text        NOT NULL,
    source_manga_id integer     NOT NULL,
    role            text        NOT NULL CHECK (role IN ('primary', 'supplemental')),
    last_checked_at timestamptz,
    last_seen_max   numeric(10,4),
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (series_id, source_id, source_manga_id)
);

-- One primary per series; supplementals are only ever used to fill named gaps.
CREATE UNIQUE INDEX series_one_primary ON series_binding (series_id) WHERE role = 'primary';

CREATE TABLE chapter (
    series_id       bigint      NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    -- The join key across every source. Numeric so 21.5 and chapter 0 behave.
    chapter_number  numeric(10,4) NOT NULL,
    file_path       text        NOT NULL,
    page_count      integer,
    bytes           bigint,
    -- Which group translated it, and which binding it came from. Both are metadata:
    -- putting scanlator in the key would mean a source change matches nothing and
    -- re-downloads everything, which is the bug this schema exists to prevent.
    scanlator       text,
    binding_id      bigint      REFERENCES series_binding(id) ON DELETE SET NULL,
    uploaded_at     timestamptz,
    added_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (series_id, chapter_number)
);

CREATE INDEX chapter_scanlator ON chapter (series_id, scanlator);

-- Declared extension set. Suwayomi runs on emptyDir, so on every cold start this
-- table is replayed through updateExtensions instead of someone logging into a UI.
CREATE TABLE extension (
    pkg_name        text PRIMARY KEY,
    repo            text,
    version         text,
    desired         boolean     NOT NULL DEFAULT true,
    last_installed_at timestamptz
);

-- Read progress lives here rather than on one iPhone.
CREATE TABLE read_progress (
    series_id       bigint      NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    chapter_number  numeric(10,4) NOT NULL,
    last_page       integer     NOT NULL DEFAULT 0,
    completed       boolean     NOT NULL DEFAULT false,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (series_id, chapter_number)
);

-- Importer output. Identity is confirmed once, by a human, and then never
-- re-derived; this is the queue that confirmation works through.
CREATE TABLE import_candidate (
    id              bigserial PRIMARY KEY,
    folder          text        NOT NULL,
    dead_source     text,
    file_count      integer     NOT NULL,
    suwayomi_manga_id integer,
    resolved_title  text,
    -- 'exact' when a source reported this title byte-for-byte (or byte-for-byte
    -- after sanitizing), 'review' when nothing matched and a human must look.
    match_kind      text        NOT NULL CHECK (match_kind IN ('exact', 'review')),
    candidates      jsonb       NOT NULL DEFAULT '[]',
    confirmed_series_id bigint  REFERENCES series(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);
