import { gql, SOURCE_SEARCH, type Source } from "./suwayomi.js";

export type SearchHit = { id: number; title: string; url: string; thumbnailUrl: string | null };

/**
 * Asks every given source for a title, a few at a time, and hands each answer over as it
 * arrives. hits is null when the source failed: one dead source must not spoil a search.
 *
 * The search page streams these to the browser and the move-off-a-source job collects
 * them, so the pool lives here rather than in either.
 */
export async function searchEach(
  sources: Source[], query: string, concurrency: number,
  onAnswer: (src: Source, hits: SearchHit[] | null) => void | Promise<void>,
): Promise<void> {
  const queue = [...sources];
  const worker = async (): Promise<void> => {
    for (;;) {
      const src = queue.shift();
      if (!src) return;
      let hits: SearchHit[] | null;
      try {
        hits = (await gql<{ fetchSourceManga: { mangas: SearchHit[] } }>(
          SOURCE_SEARCH, { src: src.id, q: query })).fetchSourceManga.mangas;
      } catch {
        hits = null;
      }
      await onAnswer(src, hits);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}
