import { scanLegacyTree, type DiskSeries } from "./disk.js";
import { installedSources, libraryWithChapters, allManga, type Chapter } from "./suwayomi.js";

/** Loose key used only to group folders that are obviously the same series. */
export const normalize = (s: string): string =>
  s.replace(/_/g, " ").toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const wholeNumbers = (chapters: Chapter[], downloadedOnly: boolean): Set<number> => {
  const out = new Set<number>();
  for (const c of chapters) {
    if (downloadedOnly && !c.isDownloaded) continue;
    if (c.chapterNumber === null) continue;
    if (Number.isInteger(c.chapterNumber)) out.add(c.chapterNumber);
  }
  return out;
};

export type SourceRollup = { sourceDir: string; series: number; files: number; live: boolean };
export type GapReport = { title: string; requeue: number[]; elsewhere: number[] };

export type Inventory = {
  disk: DiskSeries[];
  folders: number;
  distinct: number;
  tracked: number;
  untracked: number;
  duplicated: Array<{ key: string; copies: DiskSeries[] }>;
  bySource: SourceRollup[];
  strandedSeries: number;
  strandedFiles: number;
  sourceFiles: number;
  duplicateChapters: { total: number; series: number };
  gaps: { requeue: number; elsewhere: number; detail: GapReport[] };
};

export async function buildInventory(): Promise<Inventory> {
  const [disk, sources, library, everything] = await Promise.all([
    scanLegacyTree(), installedSources(), libraryWithChapters(), allManga(),
  ]);
  const live = new Set(sources.map((s) => s.displayName));

  const groups = new Map<string, DiskSeries[]>();
  for (const d of disk) {
    const k = normalize(d.folder);
    const list = groups.get(k);
    if (list) list.push(d); else groups.set(k, [d]);
  }

  const inLibrary = new Set(everything.filter((m) => m.inLibrary).map((m) => normalize(m.title)));

  const rollup = new Map<string, { series: number; files: number }>();
  for (const d of disk) {
    if (!d.sourceDir) continue;
    const r = rollup.get(d.sourceDir) ?? { series: 0, files: 0 };
    r.series++; r.files += d.cbzCount;
    rollup.set(d.sourceDir, r);
  }
  const bySource: SourceRollup[] = [...rollup].
    map(([sourceDir, r]) => ({ sourceDir, ...r, live: live.has(sourceDir) })).
    sort((a, b) => b.files - a.files);

  let strandedSeries = 0, strandedFiles = 0;
  for (const s of bySource) {
    if (s.live) continue;
    strandedSeries += s.series; strandedFiles += s.files;
  }

  // Duplicate-numbered chapters: the "wait, I already read this" problem. Counted
  // per downloaded chapter number, so two scanlations of ch 70 is one redundancy.
  let dupTotal = 0, dupSeries = 0;
  const detail: GapReport[] = [];
  let requeue = 0, elsewhere = 0;
  for (const m of library) {
    const counts = new Map<number, number>();
    for (const c of m.chapters.nodes) {
      if (!c.isDownloaded || c.chapterNumber === null) continue;
      counts.set(c.chapterNumber, (counts.get(c.chapterNumber) ?? 0) + 1);
    }
    let d = 0;
    for (const n of counts.values()) if (n > 1) d += n - 1;
    if (d > 0) { dupTotal += d; dupSeries++; }

    const have = wholeNumbers(m.chapters.nodes, true);
    const listed = wholeNumbers(m.chapters.nodes, false);
    if (have.size < 3) continue;
    const lo = Math.min(...have), hi = Math.max(...have);
    const missing: number[] = [];
    for (let i = lo; i <= hi; i++) if (!have.has(i)) missing.push(i);
    if (missing.length === 0) continue;
    // A gap the bound source still lists is a failed download, not a migration.
    const r = missing.filter((n) => listed.has(n));
    const e = missing.filter((n) => !listed.has(n));
    requeue += r.length; elsewhere += e.length;
    detail.push({ title: m.title, requeue: r, elsewhere: e });
  }

  return {
    disk,
    folders: disk.length,
    distinct: groups.size,
    tracked: [...groups.keys()].filter((k) => inLibrary.has(k)).length,
    untracked: [...groups.keys()].filter((k) => !inLibrary.has(k)).length,
    duplicated: [...groups].filter(([, v]) => v.length > 1).map(([key, copies]) => ({ key, copies })),
    bySource,
    strandedSeries,
    strandedFiles,
    sourceFiles: bySource.reduce((a, s) => a + s.files, 0),
    duplicateChapters: { total: dupTotal, series: dupSeries },
    gaps: { requeue, elsewhere, detail },
  };
}
