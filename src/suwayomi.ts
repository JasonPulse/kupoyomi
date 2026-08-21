import { config } from "./config.js";

type GqlResponse<T> = { data?: T; errors?: Array<{ message: string }> };

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(config.suwayomiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`suwayomi ${res.status} ${res.statusText}`);
  const body = (await res.json()) as GqlResponse<T>;
  if (body.errors?.length) throw new Error(`suwayomi graphql: ${body.errors[0]!.message}`);
  if (!body.data) throw new Error("suwayomi returned no data");
  return body.data;
}

export type Source = { id: string; displayName: string; lang: string; isNsfw: boolean };
export type Chapter = {
  chapterNumber: number | null;
  isDownloaded: boolean;
  scanlator: string | null;
  uploadDate: string | null;
};
export type Manga = {
  id: number;
  title: string;
  status: string;
  inLibrary: boolean;
  downloadCount: number;
  source: { displayName: string } | null;
};

export const installedSources = async (): Promise<Source[]> =>
  (await gql<{ sources: { nodes: Source[] } }>(
    `{ sources { nodes { id displayName lang isNsfw } } }`,
  )).sources.nodes;

/** Every manga row, including the thousands of search stubs. */
export const allManga = async (): Promise<Manga[]> =>
  (await gql<{ mangas: { nodes: Manga[] } }>(
    `{ mangas { nodes { id title status inLibrary downloadCount source { displayName } } } }`,
  )).mangas.nodes;

export const libraryWithChapters = async (): Promise<Array<Manga & { chapters: { nodes: Chapter[] } }>> =>
  (await gql<{ mangas: { nodes: Array<Manga & { chapters: { nodes: Chapter[] } }> } }>(
    `{ mangas(condition:{inLibrary:true}) { nodes {
         id title status inLibrary downloadCount source { displayName }
         chapters { nodes { chapterNumber isDownloaded scanlator uploadDate } } } } }`,
  )).mangas.nodes;

/**
 * Suwayomi replaces filesystem-illegal characters with '_', so
 * "Tsukimichi: Moonlit Fantasy" is stored on disk as "Tsukimichi_ Moonlit Fantasy".
 * Comparing folder names to source titles has to happen in this space or it
 * silently misses every title containing a colon or a quote.
 */
export const sanitize = (s: string): string => s.replace(/[\\/:*?"<>|]/g, "_").trim();
