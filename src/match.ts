import { db } from "./db.js";
import { scanLegacyTree } from "./disk.js";
import { gql, installedSources, sanitize } from "./suwayomi.js";

export type Candidate = {
  sourceName: string; sourceId: string; mangaId: number; title: string;
  /** Source-relative url. Stable across Suwayomi instances, unlike mangaId. */
  url?: string;
  matched: "title" | "sanitized";
};
export type Stranded = {
  folder: string;
  deadSource: string;
  files: number;
  suwayomiMangaId: number | null;
  /** The source's real title when a db row survives, otherwise the sanitized folder name. */
  title: string;
  exactTitleKnown: boolean;
  candidates: Candidate[];
};

const SEARCH = `mutation($src:LongString!,$q:String!){
  fetchSourceManga(input:{source:$src,type:SEARCH,query:$q,page:1}){ mangas{ id title url } } }`;

export async function findHomes(opts: { only?: string; limit?: number; includeNsfw?: boolean } = {}) {
  const [disk, sources] = await Promise.all([scanLegacyTree(), installedSources()]);
  const live = new Set(sources.map((s) => s.displayName));
  // Real titles come from the snapshot, not from Suwayomi: the running instance is
  // stateless by design and knows nothing about the old library.
  const downloaded = (await db().query<{ id: number; title: string }>(
    "SELECT suwayomi_id AS id, title FROM legacy_manga WHERE download_count > 0")).rows;

  let stranded: Stranded[] = [];
  for (const d of disk) {
    if (!d.sourceDir || live.has(d.sourceDir) || d.cbzCount === 0) continue;
    const row = downloaded.find((m) => sanitize(m.title) === d.folder);
    stranded.push({
      folder: d.folder,
      deadSource: d.sourceDir,
      files: d.cbzCount,
      suwayomiMangaId: row?.id ?? null,
      title: row?.title ?? d.folder,
      exactTitleKnown: row !== undefined,
      candidates: [],
    });
  }
  stranded.sort((a, b) => b.files - a.files);
  if (opts.only) {
    const needle = opts.only.toLowerCase();
    stranded = stranded.filter((s) => s.folder.toLowerCase().includes(needle));
  }
  if (opts.limit) stranded = stranded.slice(0, opts.limit);

  // 17 of the 20 en/all sources are nsfw-flagged, including ones this library
  // already uses, so they are in the pool unless explicitly excluded.
  const pool = sources.filter(
    (s) => (s.lang === "en" || s.lang === "all") && (opts.includeNsfw !== false || !s.isNsfw),
  );
  console.error(`searching ${pool.length} en/all sources for ${stranded.length} stranded series ` +
    `(${stranded.length * pool.length} queries)\n`);

  for (const s of stranded) {
    // Without a surviving db row we only know the sanitized title, so search the
    // underscores-as-spaces form and compare in sanitized space. Still exact,
    // just immune to '_' standing in for any of \ / : * ? " < > |.
    const query = s.exactTitleKnown ? s.title : s.title.replace(/_/g, " ");
    for (const src of pool) {
      let hits: Array<{ id: number; title: string; url: string }>;
      try {
        hits = (await gql<{ fetchSourceManga: { mangas: Array<{ id: number; title: string; url: string }> } }>(
          SEARCH, { src: src.id, q: query })).fetchSourceManga.mangas;
      } catch {
        continue;   // a dead or rate-limited source is not a reason to abandon the sweep
      }
      for (const m of hits) {
        const byTitle = m.title === s.title;
        const bySanitized = sanitize(m.title) === s.folder;
        if (!byTitle && !bySanitized) continue;   // 100% match only, never fuzzy
        s.candidates.push({
          sourceName: src.displayName, sourceId: src.id, mangaId: m.id, url: m.url,
          title: m.title, matched: byTitle ? "title" : "sanitized",
        });
      }
    }
    console.error(`  ${String(s.files).padStart(5)} files  ${s.title.slice(0, 44).padEnd(44)} -> ${s.candidates.length} exact`);
  }

  const resolved = stranded.filter((s) => s.candidates.length > 0);
  const review = stranded.filter((s) => s.candidates.length === 0);
  return { resolved, review };
}

/**
 * Chapter count, gaps and the last few uploads per candidate: the migration
 * comparison view. A search result has a manga row but no chapter list, so this
 * primes it from the source first -- comparing candidates means asking the sources,
 * there is no way around the round trip.
 */
export async function compare(mangaId: number) {
  try {
    await gql(`mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchChapters:true,fetchManga:true}){ clientMutationId } }`,
      { id: mangaId });
  } catch {
    // A source that reports no chapters, or is briefly unreachable, is a fact about
    // that candidate rather than a reason to abandon the whole comparison. Fall
    // through and report whatever is already known.
  }
  const d = await gql<{ manga: { title: string; source: { displayName: string } | null;
    chapters: { totalCount: number; nodes: Array<{ chapterNumber: number | null; uploadDate: string | null; scanlator: string | null }> } } }>(
    `{ manga(id:${mangaId}){ title source{displayName} chapters{ totalCount nodes{ chapterNumber uploadDate scanlator } } } }`);
  const nums = [...new Set(d.manga.chapters.nodes.map((c) => c.chapterNumber).filter((n): n is number => n !== null))].sort((a, b) => a - b);
  const whole = new Set(nums.filter(Number.isInteger));
  const missing: number[] = [];
  if (whole.size > 0) {
    for (let i = Math.min(...whole); i <= Math.max(...whole); i++) if (!whole.has(i)) missing.push(i);
  }
  const dated = d.manga.chapters.nodes.filter((c) => c.uploadDate).sort((a, b) => Number(a.uploadDate) - Number(b.uploadDate));
  return {
    offered: nums,
    source: d.manga.source?.displayName ?? "-",
    title: d.manga.title,
    chapters: d.manga.chapters.totalCount,
    range: nums.length > 0 ? ([nums[0]!, nums[nums.length - 1]!] as const) : null,
    missing,
    latest: dated.slice(-4).reverse().map((c) => ({
      chapter: c.chapterNumber, scanlator: c.scanlator,
      uploaded: new Date(Number(c.uploadDate)).toISOString().slice(0, 10),
    })),
  };
}


/**
 * Query variants, widest match kept last.
 *
 * Sites index titles with straight punctuation, so a stored title carrying a curly
 * apostrophe finds nothing: "I’m being raised by villains" returned 0 results where
 * "I'm being raised by villains" returned the right entry. Being liberal with the query
 * is safe because the match is on url, which is exact -- a wider search cannot produce
 * a wrong answer, only a slower one.
 */
export function queryVariants(title: string): string[] {
  const straight = title
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...");
  const stripped = straight.replace(/['"!?,.:;~*]/g, "").replace(/\s+/g, " ").trim();
  const words = stripped.split(" ");
  const out = [title, straight, stripped];
  // The part before a colon or dash is how long light-novel titles are usually
  // indexed: "7th Time Loop: The Villainess..." is listed as "7th Time Loop".
  const head = straight.split(/\s*[:\u2013\u2014-]\s+|:/)[0]?.trim();
  if (head && head !== straight && head.length >= 4) out.push(head);
  // Last resorts: drop the leading pronoun many titles start with, then a word prefix.
  if (words.length > 3) out.push(words.slice(1).join(" "));
  if (words.length > 5) out.push(words.slice(0, 5).join(" "));
  return [...new Set(out.filter((q) => q.length >= 4))];
}

/** Sources are inconsistent about the trailing slash on a manga url. */
const sameUrl = (a: string, b: string): boolean =>
  a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/**
 * Resolves a stable (source, url) pair to a manga id on whichever Suwayomi we are
 * talking to now. Searching and matching on url is deterministic and does not care
 * that the instance was rebuilt from scratch.
 */
export async function resolveManga(sourceId: string, title: string, url: string): Promise<number> {
  const tried: string[] = [];
  for (const q of queryVariants(title)) {
    tried.push(q);
    let hits: Array<{ id: number; title: string; url: string }>;
    try {
      hits = (await gql<{ fetchSourceManga: { mangas: Array<{ id: number; title: string; url: string }> } }>(
        SEARCH, { src: sourceId, q })).fetchSourceManga.mangas;
    } catch {
      continue;
    }
    const exact = hits.find((m) => sameUrl(m.url, url));
    if (exact) return exact.id;
  }
  throw new Error(`source ${sourceId} does not return ${url} for any of ${tried.length} query forms`);
}
