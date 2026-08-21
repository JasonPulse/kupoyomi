-- Cover and synopsis on the series itself. komf exists in this stack purely to stop
-- Komga using the first page of a CBZ as the cover; owning the cover here removes that
-- job, and writing it into the series folder means any reader picks it up.
ALTER TABLE series ADD COLUMN description text;
ALTER TABLE series ADD COLUMN metadata_at timestamptz;
