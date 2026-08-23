-- Other names a series goes by.
--
-- Half the folders on disk are romanised Japanese: Kusuriya_no_Hitorigoto is The
-- Apothecary Diaries, Sousou_no_Frieren is Frieren: Beyond Journey's End,
-- Otomege_Sekai_wa_Mob_ni_Kibishii_Sekai_desu is Trapped in a Dating Sim. None shares a
-- letter with its English title, so no similarity measure will ever connect them and the
-- link has to be stated once and remembered.
--
-- Kept normalised as well as verbatim: the verbatim form is what a person reads, the
-- normalised form is what matching compares, and computing it on every comparison across
-- eighty folders and sixty series is wasted work.
CREATE TABLE series_alias (
    series_id  integer     NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    alias      text        NOT NULL,
    norm       text        NOT NULL,
    -- 'manual' typed in, 'folder' learned by linking a folder whose name was the alias.
    origin     text        NOT NULL DEFAULT 'manual',
    added_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (series_id, norm)
);

-- An alias must not point at two series, or a folder matching it adopts into whichever
-- one the query happened to return first.
CREATE UNIQUE INDEX series_alias_unique ON series_alias (norm);
