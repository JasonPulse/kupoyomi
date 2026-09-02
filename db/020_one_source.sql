-- One source per series, not a primary with helpers underneath it.
--
-- "primary" and "supplemental" described sources that were all usable at once, with a
-- hierarchy between them. That was the wrong model and the words cost real time: adding
-- a source from the migrate page created a supplemental, which reads as switching and is
-- not, so Mf Ghost sat with a dead Mangabat still serving every download while XCOMIC
-- sat underneath it doing nothing.
--
-- A series has one source. Switching replaces it. Older bindings stay, because
-- chapter.binding_id points at them and how a file we hold got here is worth keeping,
-- but they are history and nothing reads them to download or to check for updates.

-- The old check has to go before the rows can be renamed: it forbids the new words, so
-- rewriting the rows first fails on its own constraint.
ALTER TABLE series_binding DROP CONSTRAINT series_binding_role_check;

UPDATE series_binding SET role = 'active' WHERE role = 'primary';
UPDATE series_binding SET role = 'former' WHERE role = 'supplemental';

ALTER TABLE series_binding ADD CONSTRAINT series_binding_role_check
      CHECK (role IN ('active', 'former'));

DROP INDEX series_one_primary;
CREATE UNIQUE INDEX series_one_active ON series_binding (series_id) WHERE role = 'active';
