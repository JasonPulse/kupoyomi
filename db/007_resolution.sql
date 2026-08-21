-- A stranded series has two valid endings, not one. It can be migrated to a new
-- source, or it can be finished -- complete, nothing left to publish, no source worth
-- binding. The second was previously unrepresentable, so completed series sat in the
-- review queue forever offering migrations nobody wants.
ALTER TABLE import_candidate
  ADD COLUMN resolution text CHECK (resolution IN ('migrated', 'archived'));
