import { config } from "./config.js";

type GqlResponse<T> = { data?: T; errors?: Array<{ message: string }> };

/**
 * Every call is bounded. Without a timeout one unresponsive source hung the scheduler's
 * scan indefinitely, and because scan and fetch shared a lock, downloading stopped
 * altogether for hours with nothing in the logs to say why.
 */
export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const ms = Number(process.env["SUWAYOMI_TIMEOUT_MS"] ?? 45_000);
  const res = await fetch(config.suwayomiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw new Error(`suwayomi ${res.status} ${res.statusText}`);
  const body = (await res.json()) as GqlResponse<T>;
  if (body.errors?.length) throw new Error(`suwayomi graphql: ${body.errors[0]!.message}`);
  if (!body.data) throw new Error("suwayomi returned no data");
  return body.data;
}

export type Source = { id: string; displayName: string; lang: string; isNsfw: boolean; supportsLatest: boolean };
export type Chapter = {
  name: string | null;
  pageCount: number | null;
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
    `{ sources { nodes { id displayName lang isNsfw supportsLatest } } }`,
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
         chapters { nodes { name pageCount chapterNumber isDownloaded scanlator uploadDate } } } } }`,
  )).mangas.nodes;

/**
 * Suwayomi replaces filesystem-illegal characters with '_', so
 * "Tsukimichi: Moonlit Fantasy" is stored on disk as "Tsukimichi_ Moonlit Fantasy".
 * Comparing folder names to source titles has to happen in this space or it
 * silently misses every title containing a colon or a quote.
 */
export const sanitize = (s: string): string => s.replace(/[\\/:*?"<>|]/g, "_").trim();

/**
 * Suwayomi's own on-disk name for a chapter: "{scanlator}_{name}.cbz", or "{name}.cbz".
 *
 * Written in held.ts to match files against snapshot rows, and again in seed.ts to do the
 * same job. Both had to agree exactly or a chapter's metadata attached to the wrong file.
 */
export const legacyChapterFile = (name: string | null, scanlator: string | null): string =>
  `${scanlator ? `${sanitize(scanlator)}_${sanitize(name ?? "")}` : sanitize(name ?? "")}.cbz`;

export type Extension = { pkgName: string; repo: string | null; versionName: string };

export const installedExtensions = async (): Promise<Extension[]> =>
  (await gql<{ extensions: { nodes: Extension[] } }>(
    `{ extensions(condition:{isInstalled:true}) { nodes { pkgName repo versionName } } }`,
  )).extensions.nodes;

/**
 * Makes a source fetch a manga and its chapter list before we read it.
 *
 * A search result has a manga row and no chapters, so every caller that wanted a chapter
 * count had to prime it first. Five of them wrote this mutation out inline. Never fatal:
 * a source that is briefly unreachable is a fact about that candidate, not a reason to
 * abandon whatever the caller was doing.
 */
export const primeManga = async (id: number, withChapters = true): Promise<void> => {
  await gql(
    `mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchChapters:${
      withChapters ? "true" : "false"},fetchManga:true}){ clientMutationId } }`,
    { id },
  ).catch(() => undefined);
};

/**
 * Just the chapter numbers a source carries, primed first.
 *
 * Four callers wrote this query out inline to ask the same question.
 */
export const chapterNumbersOf = async (id: number): Promise<number[]> => {
  await primeManga(id);
  return (await gql<{ manga: { chapters: { nodes: Array<{ chapterNumber: number | null }> } } }>(
    `{ manga(id:${id}) { chapters { nodes { chapterNumber } } } }`,
  )).manga.chapters.nodes
    .map((c) => c.chapterNumber)
    .filter((n): n is number => n !== null);
};

/** The search every surface uses. It was written out three times, once with a stale shape. */
export const SOURCE_SEARCH = `mutation($src:LongString!,$q:String!){
  fetchSourceManga(input:{source:$src,type:SEARCH,query:$q,page:1}){
    mangas{ id title url thumbnailUrl } } }`;

export const mangaChapters = async (id: number): Promise<Chapter[]> =>
  (await gql<{ manga: { chapters: { nodes: Chapter[] } } }>(
    `{ manga(id:${id}) { chapters { nodes { name pageCount chapterNumber isDownloaded scanlator uploadDate } } } }`,
  )).manga.chapters.nodes;

export const serverAbout = async (): Promise<{ version: string; revision: string }> =>
  (await gql<{ aboutServer: { version: string; revision: string } }>(
    `{ aboutServer { version revision } }`)).aboutServer;

/**
 * Pulls the extension repo index. A fresh Suwayomi reports zero available
 * extensions until this runs, so an install issued before it fails on an unknown
 * package name. Verified against a clean container: 0 before, 1372 after.
 */
export const fetchExtensionIndex = async (): Promise<number> =>
  (await gql<{ fetchExtensions: { extensions: Array<{ pkgName: string }> } }>(
    `mutation{ fetchExtensions(input:{}){ extensions{ pkgName } } }`,
  )).fetchExtensions.extensions.length;
