-- "adds" and "loses" conflated three different things and misled on all of them.
-- What matters is: how many genuinely new chapters sit past what you already have,
-- how many holes in your run this source could fill, and how much of your run it
-- simply does not carry. Nothing is ever lost by migrating -- the ledger keeps every
-- file -- so a source lacking chapters is information, not a cost.
ALTER TABLE candidate_comparison
  ADD COLUMN new_beyond  integer,   -- offered above your highest held chapter
  ADD COLUMN fills_gaps  integer,   -- offered inside your range that you lack
  ADD COLUMN not_carried integer;   -- you hold it, the source does not
