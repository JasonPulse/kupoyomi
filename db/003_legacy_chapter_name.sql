-- The legacy files are named "{scanlator}_{name}.cbz", so without the chapter name
-- a ledger row cannot be matched to the file it already owns, which is the whole
-- basis of migrating without re-downloading. Recoverable only while the old
-- Suwayomi still exists.
ALTER TABLE legacy_chapter ADD COLUMN name text;
