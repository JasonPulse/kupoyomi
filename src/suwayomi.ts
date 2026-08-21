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

export type Extension = { pkgName: string; repo: string | null; versionName: string };

export const installedExtensions = async (): Promise<Extension[]> =>
  (await gql<{ extensions: { nodes: Extension[] } }>(
    `{ extensions(condition:{isInstalled:true}) { nodes { pkgName repo versionName } } }`,
  )).extensions.nodes;

export const mangaChapters = async (id: number): Promise<Chapter[]> =>
  (await gql<{ manga: { chapters: { nodes: Chapter[] } } }>(
    `{ manga(id:${id}) { chapters { nodes { chapterNumber isDownloaded scanlator uploadDate } } } }`,
  )).manga.chapters.nodes;

/** Installs an extension by package name. This is what replaces logging into the UI. */
export const installExtension = async (pkgName: string): Promise<void> => {
  await gql(`mutation($pkg:String!){ updateExtension(input:{id:$pkg,patch:{install:true}}){ clientMutationId } }`,
    { pkg: pkgName });
};

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
