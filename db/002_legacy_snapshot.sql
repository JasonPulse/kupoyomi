-- Captured before the old Suwayomi is torn down. Its H2 database is the only place
-- that knows library membership, per-chapter isDownloaded, which sources are still
-- installed, and the real (unsanitized) title for folders whose name had a colon in
-- it. None of that is reconstructable from the files on disk.

CREATE TABLE legacy_manga (
    suwayomi_id     integer PRIMARY KEY,
    title           text        NOT NULL,
    source_name     text,
    status          text,
    in_library      boolean     NOT NULL,
    download_count  integer     NOT NULL,
    captured_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legacy_chapter (
    suwayomi_manga_id integer   NOT NULL REFERENCES legacy_manga(suwayomi_id) ON DELETE CASCADE,
    chapter_number  numeric(10,4),
    is_downloaded   boolean     NOT NULL,
    scanlator       text,
    page_count      integer,
    uploaded_at     timestamptz
);

CREATE INDEX legacy_chapter_manga ON legacy_chapter (suwayomi_manga_id);
CREATE INDEX legacy_chapter_downloaded ON legacy_chapter (suwayomi_manga_id) WHERE is_downloaded;

-- Which sources were live at capture time. Anything on disk under a source absent
-- from here is stranded, and that judgement cannot be made later.
CREATE TABLE legacy_source (
    source_id       text PRIMARY KEY,
    display_name    text        NOT NULL,
    lang            text,
    is_nsfw         boolean     NOT NULL DEFAULT false
);
