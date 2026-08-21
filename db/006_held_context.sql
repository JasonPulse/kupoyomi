-- A candidate's chapter count means nothing on its own. The decision is whether it
-- adds chapters you do not have and whether it loses chapters you do, so both sides
-- of that comparison get stored.
ALTER TABLE import_candidate
  ADD COLUMN held_count   integer,
  ADD COLUMN held_lo      numeric(10,4),
  ADD COLUMN held_hi      numeric(10,4),
  ADD COLUMN held_numbers jsonb;

ALTER TABLE candidate_comparison
  ADD COLUMN new_count  integer,
  ADD COLUMN lost_count integer,
  ADD COLUMN last_upload date;
