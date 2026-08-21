-- Nothing recorded what was actually in flight: state went pending -> done with no
-- window in between, so a download in progress was invisible.
ALTER TABLE wanted ADD COLUMN started_at timestamptz;
ALTER TABLE wanted ADD COLUMN pages_done integer;
ALTER TABLE wanted ADD COLUMN pages_total integer;
