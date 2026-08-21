-- Suwayomi manga ids are per-instance row ids. The whole point of this design is that
-- the Suwayomi pod is disposable, so a binding keyed on its row id breaks the moment
-- it is replaced. The source's own manga url is stable across instances -- it is what
-- the extension itself uses -- so bindings key on that and resolve to a local id at
-- use time.
ALTER TABLE series_binding ADD COLUMN source_url text;
CREATE INDEX series_binding_source_url ON series_binding (source_id, source_url);
