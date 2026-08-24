-- When a failed chapter may be tried again.
--
-- There was no waiting at all. A failure set state='failed' and the row was picked up on
-- the series' next turn, so four attempts could burn inside ninety minutes. 7th Time Loop
-- lost ten chapters that way between 17:07 and 18:44 while Kun Manga Online was timing
-- out, and chapter 26.6 downloaded successfully in the same window: the source was flaky,
-- not gone, and a bad hour permanently killed everything asked for during it.
--
-- Backing off spreads the same attempts across days instead of an hour, so a source
-- having a bad afternoon costs a delay rather than the chapters.
ALTER TABLE wanted ADD COLUMN retry_after timestamptz;

-- Everything already given up on gets one more chance under the new schedule, rather than
-- staying dead because it happened to fail before this existed.
UPDATE wanted SET attempts = 0, retry_after = NULL, last_error = NULL
 WHERE state = 'failed' AND attempts >= 4;
