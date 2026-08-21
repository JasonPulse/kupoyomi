import { db } from "./db.js";
import { scanLegacyTree } from "./disk.js";
import { gql, installedSources, sanitize } from "./suwayomi.js";

export type Candidate = { sourceName: string; sourceId: string; mangaId: number; title: string; matched: "title" | "sanitized" };
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
  fetchSourceManga(input:{source:$src,type:SEARCH,query:$q,page:1}){ mangas{ id title } } }`;

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
      let hits: Array<{ id: number; title: string }>;
      try {
        hits = (await gql<{ fetchSourceManga: { mangas: Array<{ id: number; title: string }> } }>(
          SEARCH, { src: src.id, q: query })).fetchSourceManga.mangas;
      } catch {
        continue;   // a dead or rate-limited source is not a reason to abandon the sweep
      }
      for (const m of hits) {
        const byTitle = m.title === s.title;
        const bySanitized = sanitize(m.title) === s.folder;
        if (!byTitle && !bySanitized) continue;   // 100% match only, never fuzzy
        s.candidates.push({
          sourceName: src.displayName, sourceId: src.id, mangaId: m.id,
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

/** Chapter count, gaps and the last few uploads per candidate: the migration comparison view. */
export async function compare(mangaId: number) {
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
