-- Whether a series may take part-numbered chapters.
--
-- Whole chapters only is right for nearly everything: 25.1 and 25.2 are one chapter split
-- by a release group, so taking both means reading it twice. But a few sources publish
-- nothing else. Kumo Desu ga, Nani ka holds 170 chapters of which 153 are halves, in
-- unbroken .1/.2 pairs from chapter 5 to chapter 80, and there is no whole chapter to take
-- instead. A single global rule would stop that series updating at all.
--
-- So the rule is global with a per-series exception, and the exception is set here for
-- every series that already looks like this: more part-numbered chapters than whole ones
-- means its source numbers in halves and always did.
ALTER TABLE series ADD COLUMN take_splits boolean NOT NULL DEFAULT false;

UPDATE series SET take_splits = true
 WHERE id IN (
   SELECT series_id FROM chapter
    GROUP BY series_id
   HAVING count(*) FILTER (WHERE chapter_number <> trunc(chapter_number))
        > count(*) FILTER (WHERE chapter_number = trunc(chapter_number)));
