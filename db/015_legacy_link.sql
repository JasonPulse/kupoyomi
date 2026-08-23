-- Which folders on disk belong to which series, stated once rather than guessed each time.
--
-- Adoption used to read a single import_candidate folder per series. 7th Time Loop had
-- two folders and only one was adopted, so a third of it was invisible to the ledger and
-- went back on the download queue. There are eleven more hand-made folders under the
-- legacy root, named with underscores and no source directory, none of them linked to
-- anything.
--
-- Name similarity can propose a link but must not decide one: "Kusuriya_no_Hitorigoto"
-- and "The Apothecary Diaries" are the same work and share no letters. So a link is a
-- recorded decision, and a rejection is recorded too, or the same wrong guess is offered
-- forever.
--
-- The library tree stays the source of truth. A link only says where a chapter may be
-- hardlinked FROM; nothing here deletes or moves a legacy file.
CREATE TABLE legacy_link (
    series_id   integer     NOT NULL REFERENCES series(id) ON DELETE CASCADE,
    path        text        NOT NULL,
    -- 'linked' adopts from it. 'ignored' never proposes it for this series again.
    state       text        NOT NULL DEFAULT 'linked',
    decided_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (series_id, path)
);

-- One folder can legitimately serve one series only: two series adopting the same file
-- would give both the same chapter and one of them the wrong story.
CREATE UNIQUE INDEX legacy_link_one_owner ON legacy_link (path) WHERE state = 'linked';
