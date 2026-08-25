import { linkSync, mkdirSync, existsSync, statSync, readdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";
import { db } from "./db.js";
import { scanLegacyTree } from "./disk.js";
import { parseChapterNumber } from "./chapternum.js";
import { chapterFilename } from "./remap.js";

/**
 * Adopts chapters already on disk into a series, from every folder that holds them.
 *
 * remap adopts from one folder: the single import_candidate row confirmed for the
 * series. 7th Time Loop had two, a MangaFire folder with 46 files and a hand-made
 * top-level folder with 29, and only the first was ever adopted. So chapters 1, 5.5 and
 * 21.5 sat on disk while the queue was downloading them again, which is the exact
 * complaint this project was built to answer.
 *
 * Matching a folder to a series is a judgement call, so this reports what it would take
 * and takes it only when told. Chapter numbers come from filenames, because a hand-made
 * folder was never in any snapshot.
 */
export type AdoptSource = {
  path: string; folder: string; sourceDir: string | null;
  /** True when the owner linked this folder. False means it is only a name-match guess. */
  linked: boolean;
  /** Chapter number to the file that would supply it, for chapters not already held. */
  offers: Map<number, string>;
  /** How many of its files are chapters the series already holds. */
  alreadyHeld: number;
};

export const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Records another name for a series. The normalised form is what matching compares. */
export async function addAlias(seriesId: number, alias: string, origin = "manual"): Promise<void> {
  const n = norm(alias);
  if (n.length < 3) throw new Error("an alias needs at least three letters or digits");
  await db().query(
    `INSERT INTO series_alias (series_id, alias, norm, origin) VALUES ($1,$2,$3,$4)
     ON CONFLICT (series_id, norm) DO UPDATE SET alias = EXCLUDED.alias`,
    [seriesId, alias.trim(), n, origin]);
}

export async function removeAlias(seriesId: number, alias: string): Promise<void> {
  await db().query("DELETE FROM series_alias WHERE series_id = $1 AND norm = $2",
    [seriesId, norm(alias)]);
}

export const aliasesFor = async (seriesId: number): Promise<Array<{ alias: string; origin: string }>> =>
  (await db().query<{ alias: string; origin: string }>(
    "SELECT alias, origin FROM series_alias WHERE series_id = $1 ORDER BY alias", [seriesId])).rows;

/**
 * How much of `a` is present in `b`, as a fraction, comparing letters only. Folder names
 * lose punctuation and gain underscores on the way to disk, so an exact match is no use:
 * "7th_Time_Loop_-_The_Villainess_Enjoys..." has to match "7th Time Loop: The Villainess
 * Enjoys...". A prefix test on the normalised forms is enough and cannot match by
 * accident at these lengths.
 */
const similar = (a: string, b: string): boolean => {
  if (a.length < 8 || b.length < 8) return a === b;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return longer.startsWith(shorter.slice(0, Math.max(12, Math.floor(shorter.length * 0.8))));
};

/** Matches a folder against a series title and every other name it goes by. */
const looksLikeSame = (title: string, folder: string, aliases: string[] = []): boolean => {
  const b = norm(folder);
  // An alias is a stated fact, so an exact normalised match on one is a match, full stop.
  if (aliases.includes(b)) return true;
  return similar(norm(title), b) || aliases.some((a) => similar(a, b));
};

/**
 * Folders for a series: the ones linked to it, plus name-matched proposals.
 *
 * `linked` is a decision the owner made and is the only thing adoption acts on. A
 * proposal is a guess from the folder name, offered for confirmation, because names lose
 * their punctuation on the way to disk and some do not survive translation at all:
 * "Kusuriya_no_Hitorigoto" is "The Apothecary Diaries" and shares no letters with it.
 */
export async function findOnDisk(seriesId: number, opts: { propose?: boolean } = {}): Promise<{
  title: string; held: Set<number>; sources: AdoptSource[];
}> {
  const p = db();
  const s = (await p.query<{ title: string; folder: string }>(
    "SELECT title, folder FROM series WHERE id = $1", [seriesId])).rows[0];
  if (!s) throw new Error(`no series ${seriesId}`);
  const held = new Set((await p.query<{ n: string }>(
    "SELECT chapter_number AS n FROM chapter WHERE series_id = $1", [seriesId])).rows.map((r) => Number(r.n)));
  const decided = new Map((await p.query<{ path: string; state: string }>(
    "SELECT path, state FROM legacy_link WHERE series_id = $1", [seriesId])).rows.map((r) => [r.path, r.state]));
  const aliases = (await p.query<{ norm: string }>(
    "SELECT norm FROM series_alias WHERE series_id = $1", [seriesId])).rows.map((r) => r.norm);
  // A folder already linked to another series is not available to this one.
  const takenElsewhere = new Set((await p.query<{ path: string }>(
    "SELECT path FROM legacy_link WHERE state = 'linked' AND series_id <> $1", [seriesId])).rows.map((r) => r.path));

  const sources: AdoptSource[] = [];
  for (const d of await scanLegacyTree()) {
    if (d.cbzCount === 0) continue;         // nothing to adopt from an empty folder
    const dirPath = d.sourceDir ? `${config.legacyRoot}/${d.sourceDir}/${d.folder}` : `${config.legacyRoot}/${d.folder}`;
    const state = decided.get(dirPath);
    if (state === "ignored") continue;
    if (takenElsewhere.has(dirPath)) continue;
    const linked = state === "linked";
    // Guesses only when asked for. Adoption acts on decisions.
    if (!linked && !(opts.propose && looksLikeSame(s.title, d.folder, aliases))) continue;
    const dir = dirPath;
    // One file per chapter number, largest wins: the ledger allows exactly one, and the
    // largest file is the complete scanlation rather than a truncated retry.
    const best = new Map<number, { file: string; size: number }>();
    let alreadyHeld = 0;
    for (const f of d.files) {
      const n = parseChapterNumber(f);
      if (n === null) continue;
      if (held.has(n)) { alreadyHeld++; continue; }
      let size = 0;
      try { size = statSync(`${dir}/${f}`).size; } catch { continue; }
      const prev = best.get(n);
      if (!prev || size > prev.size) best.set(n, { file: f, size });
    }
    sources.push({
      path: dir, folder: d.folder, sourceDir: d.sourceDir, alreadyHeld, linked,
      offers: new Map([...best.entries()].map(([n, v]) => [n, v.file])),
    });
  }
  return { title: s.title, held, sources };
}

/** Records that a folder belongs to a series, or that it does not. */
export async function setLink(seriesId: number, path: string, state: "linked" | "ignored"): Promise<void> {
  await db().query(
    `INSERT INTO legacy_link (series_id, path, state) VALUES ($1,$2,$3)
     ON CONFLICT (series_id, path) DO UPDATE SET state = EXCLUDED.state, decided_at = now()`,
    [seriesId, path, state]);
  // Linking a folder states that its name is another name for this series, which is the
  // fact that was missing. Recording it means a second folder with the same romanisation
  // is recognised, and a search for the romanised name finds the series.
  if (state === "linked") {
    const folder = path.split("/").filter(Boolean).at(-1) ?? "";
    if (norm(folder).length >= 3) {
      // A duplicate alias belongs to another series, and guessing which is wrong.
      await addAlias(seriesId, folder.replace(/_/g, " "), "folder")
        .catch(() => console.log(`  (kept the link; "${folder}" is already an alias of another series)`));
    }
  }
}

export async function adoptFromDisk(seriesId: number, opts: { dryRun?: boolean; propose?: boolean } = {}): Promise<number> {
  const p = db();
  const { title, held, sources } = await findOnDisk(seriesId, opts.propose ? { propose: true } : {});
  const series = (await p.query<{ folder: string }>(
    "SELECT folder FROM series WHERE id = $1", [seriesId])).rows[0]!;
  const targetDir = `${config.libraryRoot}/${series.folder}`;

  console.log(`${opts.dryRun ? "[dry run] " : ""}${title}: holds ${held.size} chapters`);
  if (sources.length === 0) {
    console.log(opts.propose ? "  no folder on disk looks like this series"
                             : "  no folder is linked to this series (try --propose to see guesses)");
    return 0;
  }

  // Claimed across folders, so two folders offering the same chapter adopt it once.
  const claimed = new Set<number>();
  let adopted = 0;
  for (const src of sources.sort((a, b) => b.offers.size - a.offers.size)) {
    const fresh = [...src.offers.entries()].filter(([n]) => !claimed.has(n)).sort((a, b) => a[0] - b[0]);
    console.log(`  ${src.linked ? "[linked]  " : "[proposal]"} ${src.path}`);
    console.log(`    ${src.alreadyHeld} already held, ${fresh.length} to adopt${
      fresh.length ? `: ${fresh.slice(0, 14).map(([n]) => n).join(", ")}${fresh.length > 14 ? " ..." : ""}` : ""}`);
    // A proposal is never acted on. Link it first, deliberately.
    if (opts.dryRun || !src.linked) { fresh.forEach(([n]) => claimed.add(n)); continue; }
    for (const [n, file] of fresh) {
      const dest = `${targetDir}/${chapterFilename(title, String(n), null)}`;
      try {
        mkdirSync(dirname(dest), { recursive: true });
        if (!existsSync(dest)) linkSync(`${src.path}/${file}`, dest);
        const r = await p.query(
          `INSERT INTO chapter (series_id, chapter_number, file_path, scanlator)
           VALUES ($1,$2,$3,NULL) ON CONFLICT (series_id, chapter_number) DO NOTHING`,
          [seriesId, n, dest]);
        if (r.rowCount ?? 0 > 0) { adopted++; claimed.add(n); }
      } catch (err) {
        console.log(`    could not adopt ${n}: ${err instanceof Error ? err.message.slice(0, 70) : String(err)}`);
      }
    }
  }
  if (!opts.dryRun && adopted > 0) {
    // Anything now held must leave the queue, or it downloads over the top of itself.
    const q = await p.query(
      `DELETE FROM wanted w USING chapter c
        WHERE c.series_id = w.series_id AND c.chapter_number = w.chapter_number
          AND w.series_id = $1 AND w.state <> 'done'`, [seriesId]);
    console.log(`adopted ${adopted} chapters, removed ${q.rowCount ?? 0} from the queue`);
  }
  return adopted;
}

/**
 * Every legacy folder, and what the ledger thinks of it.
 *
 * The point is to make the unlinked ones visible. Eleven hand-made folders sit under the
 * legacy root with no source directory and no link to anything, and until one is linked
 * its chapters are invisible: the library does not know they exist and the queue happily
 * downloads them again.
 */
export async function diskReport(): Promise<void> {
  const p = db();
  const tree = await scanLegacyTree();
  const links = (await p.query<{ series_id: number; path: string; state: string; title: string }>(
    `SELECT l.series_id, l.path, l.state, s.title
       FROM legacy_link l JOIN series s ON s.id = l.series_id`)).rows;
  const byPath = new Map(links.map((l) => [l.path, l]));
  const series = (await p.query<{ id: number; title: string; aliases: string[] | null }>(
    `SELECT s.id, s.title, array_remove(array_agg(a.norm), NULL) AS aliases
       FROM series s LEFT JOIN series_alias a ON a.series_id = s.id
      GROUP BY s.id, s.title`)).rows;

  let linked = 0, ignored = 0, loose = 0, empty = 0;
  const rows: string[] = [];
  for (const d of tree.sort((a, b) => b.cbzCount - a.cbzCount || a.folder.localeCompare(b.folder))) {
    // A folder with no archive in it has nothing to adopt. Most of these are the source
    // containers themselves and Suwayomi's thumbnail cache, which are not series at all.
    if (d.cbzCount === 0) { empty++; continue; }
    const path = d.sourceDir ? `${config.legacyRoot}/${d.sourceDir}/${d.folder}` : `${config.legacyRoot}/${d.folder}`;
    const l = byPath.get(path);
    if (l?.state === "linked") { linked++; continue; }
    if (l?.state === "ignored") { ignored++; continue; }
    loose++;
    const guesses = series.filter((s) => looksLikeSame(s.title, d.folder, s.aliases ?? []));
    rows.push(`  ${String(d.cbzCount).padStart(4)} files  ${d.sourceDir ? "" : "(no source dir) "}${d.folder.slice(0, 62)}`
      + (guesses.length ? `\n           looks like: ${guesses.map((g) => `${g.id} ${g.title.slice(0, 44)}`).join("; ")}`
                        : `\n           no series matches by name -- link it by hand if you know which it is`));
  }
  console.log(`${tree.length} folders on disk: ${linked} linked, ${ignored} ignored, ${loose} undecided, `
    + `${empty} holding no archives (source directories and caches)`);
  if (rows.length) {
    console.log(`\nundecided, so their chapters are invisible to the library:`);
    console.log(rows.join("\n"));
    console.log(`\nlink one with:  kupo link <seriesId> '<path>'`);
    console.log(`ignore one with: kupo link <seriesId> '<path>' --ignore`);
  }
}

/**
 * Folders holding archives that no series has claimed.
 *
 * Needed because a name match cannot find them all: "Sousou_no_Frieren" is "Frieren:
 * Beyond Journey's End" and "Kusuriya_no_Hitorigoto" is "The Apothecary Diaries". Neither
 * shares a letter with its English title, so neither will ever be proposed and both have
 * to be pointed at a series by hand.
 */
export async function unclaimedFolders(): Promise<Array<{ path: string; folder: string; files: number }>> {
  const claimed = new Set((await db().query<{ path: string }>(
    "SELECT path FROM legacy_link WHERE state = 'linked'")).rows.map((r) => r.path));
  return (await scanLegacyTree())
    .filter((d) => d.cbzCount > 0)
    .map((d) => ({
      path: d.sourceDir ? `${config.legacyRoot}/${d.sourceDir}/${d.folder}` : `${config.legacyRoot}/${d.folder}`,
      folder: d.folder, files: d.cbzCount,
    }))
    .filter((d) => !claimed.has(d.path))
    .sort((a, b) => b.files - a.files);
}

/**
 * Linked folders that offer nothing the library does not already hold.
 *
 * Once every chapter in a folder is held, the folder is a second copy and the library
 * tree is the one that counts. Reported with the space it would free, and deleted only
 * when asked, because this is the one operation here that destroys something.
 *
 * Two guards. Only folders explicitly linked are considered, so a name-match guess can
 * never lead to a deletion. And a folder is only redundant if every chapter number in it
 * is held: a single chapter the ledger lacks keeps the whole folder.
 */
export async function redundantFolders(): Promise<Array<{
  seriesId: number; title: string; path: string; files: number;
  /** Total size of the folder. */
  bytes: number;
  /** What deleting it would actually reclaim. An adopted chapter is a hardlink, so the
   *  library holds the same inode and removing this name frees nothing at all. */
  reclaimable: number;
  linkedCopies: number;
  heldAll: boolean;
}>> {
  const p = db();
  const links = (await p.query<{ series_id: number; path: string; title: string; take_splits: boolean }>(
    `SELECT l.series_id, l.path, s.title, s.take_splits
       FROM legacy_link l JOIN series s ON s.id = l.series_id
      WHERE l.state = 'linked' ORDER BY s.title`)).rows;
  const out: Array<{ seriesId: number; title: string; path: string; files: number;
    bytes: number; reclaimable: number; linkedCopies: number; heldAll: boolean }> = [];
  for (const l of links) {
    const held = new Set((await p.query<{ n: string }>(
      "SELECT chapter_number AS n FROM chapter WHERE series_id = $1", [l.series_id])).rows.map((r) => Number(r.n)));
    let files = 0, bytes = 0, reclaimable = 0, linkedCopies = 0, missing = 0;
    let names: string[];
    try { names = readdirSync(l.path); } catch { continue; }
    for (const f of names) {
      if (!/\.cbz$/i.test(f)) continue;
      files++;
      const n = parseChapterNumber(f);
      // A file whose number cannot be read is not proven redundant, so it protects the folder.
      if (n === null) { missing++; continue; }
      // A part-numbered chapter whose whole chapter is held was deleted on purpose, so it
      // is accounted for rather than missing. Without this, 33 of the 37 folders kept back
      // were kept by our own decision and could never be pruned. A series that takes
      // splits is exempt: for it, a decimal is wanted and its absence is a real gap.
      const discarded = !l.take_splits && !Number.isInteger(n) && held.has(Math.trunc(n));
      if (!held.has(n) && !discarded) { missing++; continue; }
      if (discarded) continue;   // no file of ours to compare against, so nothing to count
      try {
        const st = statSync(`${l.path}/${f}`);
        bytes += st.size;
        // nlink above one means the library holds this same inode, so deleting this name
        // frees nothing. Summing sizes regardless reported 2.1GB for two folders where
        // most of it was the library's own files counted a second time.
        if (st.nlink > 1) linkedCopies++; else reclaimable += st.size;
      } catch { /* counted as zero */ }
    }
    if (files > 0) out.push({ seriesId: l.series_id, title: l.title, path: l.path, files, bytes, reclaimable, linkedCopies, heldAll: missing === 0 });
  }
  return out;
}

export async function pruneRedundant(opts: { delete?: boolean } = {}): Promise<void> {
  const all = await redundantFolders();
  const done = all.filter((f) => f.heldAll);
  const keep = all.filter((f) => !f.heldAll);
  console.log(`${all.length} linked folders: ${done.length} fully adopted, ${keep.length} still holding something`);
  for (const f of keep) {
    console.log(`  keeping  ${f.path}\n           ${f.files} files, some not in the library yet`);
  }
  if (done.length === 0) { console.log("nothing is redundant"); return; }
  let freed = 0;
  for (const f of done) {
    console.log(`  ${opts.delete ? "deleting" : "redundant"} ${f.path}`);
    console.log(`           ${f.files} files for "${f.title.slice(0, 40)}", every chapter held`);
    console.log(`           ${(f.bytes / 1048576).toFixed(0)}MB on disk, of which ${
      (f.reclaimable / 1048576).toFixed(0)}MB is actually reclaimable`
      + (f.linkedCopies > 0 ? ` (${f.linkedCopies} files are hardlinks the library already owns)` : ""));
    freed += f.reclaimable;
    if (!opts.delete) continue;
    try {
      rmSync(f.path, { recursive: true });
      // The link goes too: the folder it pointed at is gone, and a stale link would be
      // offered as a source of chapters that no longer exist.
      await db().query("DELETE FROM legacy_link WHERE series_id = $1 AND path = $2", [f.seriesId, f.path]);
    } catch (err) {
      console.log(`           could not delete: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
    }
  }
  console.log(`${opts.delete ? "freed" : "would free"} ${(freed / 1048576).toFixed(0)}MB across ${done.length} folders`);
  if (!opts.delete) console.log("pass --delete to remove them");
}

/**
 * Links every undecided folder whose name is exactly a series' name, normalised.
 *
 * Most of the 66 undecided folders are the source folders these series were migrated
 * from, so their names match a library title letter for letter once punctuation is
 * dropped: "Tsukimichi_ Moonlit Fantasy" against "Tsukimichi: Moonlit Fantasy". An exact
 * match on the whole name is a different proposition from a similarity score and can be
 * acted on in bulk.
 *
 * Two names matching one folder is not a match: it means the library has two series
 * called the same thing, and picking one would adopt somebody else's chapters. Those are
 * left alone and reported.
 */
export async function linkObvious(opts: { dryRun?: boolean } = {}): Promise<void> {
  const p = db();
  const named = new Map<string, Array<{ id: number; title: string }>>();
  for (const r of (await p.query<{ id: number; title: string; name: string }>(
    `SELECT id, title, title AS name FROM series
     UNION ALL SELECT s.id, s.title, a.alias AS name FROM series_alias a JOIN series s ON s.id = a.series_id`)).rows) {
    const k = norm(r.name);
    const l = named.get(k);
    if (l) { if (!l.some((x) => x.id === r.id)) l.push({ id: r.id, title: r.title }); }
    else named.set(k, [{ id: r.id, title: r.title }]);
  }

  const unclaimed = await unclaimedFolders();
  const decided = new Set((await p.query<{ path: string }>(
    "SELECT path FROM legacy_link")).rows.map((r) => r.path));

  let linked = 0, ambiguous = 0, unmatched = 0;
  for (const u of unclaimed) {
    if (decided.has(u.path)) continue;
    const hits = named.get(norm(u.folder));
    if (!hits) { unmatched++; continue; }
    if (hits.length > 1) {
      ambiguous++;
      console.log(`  ambiguous ${u.folder.slice(0, 54)}`);
      console.log(`            matches ${hits.map((h) => `${h.id} ${h.title.slice(0, 30)}`).join(", ")} -- left alone`);
      continue;
    }
    const s = hits[0]!;
    console.log(`  ${opts.dryRun ? "would link" : "linked"} ${String(u.files).padStart(4)} files  ${u.folder.slice(0, 48)}  ->  ${s.id} ${s.title.slice(0, 34)}`);
    if (!opts.dryRun) await setLink(s.id, u.path, "linked");
    linked++;
  }
  console.log(`${opts.dryRun ? "would link" : "linked"} ${linked}, ${ambiguous} ambiguous, ${unmatched} with no series of that name`);
  if (unmatched > 0) console.log(`the unmatched ones need a series: give one an "also known as", or import the folder as a new series`);
}

/**
 * Makes a series out of a folder and adopts everything in it.
 *
 * For a manually downloaded folder with no series at all: Isekai Nonbiri Nouka and The
 * New Gate are on disk and nothing in the library corresponds to them. Created without a
 * source, deliberately, because a folder cannot say where new chapters should come from.
 * It shows up as "no source" and the series page asks for one.
 */
export async function importFolder(path: string, title?: string): Promise<number> {
  const p = db();
  const folder = path.split("/").filter(Boolean).at(-1) ?? "";
  // Underscores stand in for spaces and colons on disk, and a title is read by a person.
  const name = (title ?? folder.replace(/_/g, " ").replace(/\s+/g, " ").trim());
  if (!name) throw new Error("could not work out a title; pass one");
  const { canonical } = await import("./seed.js");

  const existing = (await p.query<{ id: number; title: string }>(
    "SELECT id, title FROM series WHERE lower(folder) = lower($1)", [canonical(name)])).rows[0];
  if (existing) {
    console.log(`"${existing.title}" already exists as series ${existing.id}; linking the folder to it`);
    await setLink(existing.id, path, "linked");
    await adoptFromDisk(existing.id);
    return existing.id;
  }

  const s = await p.query<{ id: number }>(
    "INSERT INTO series (title, folder) VALUES ($1,$2) RETURNING id", [name, canonical(name)]);
  const id = s.rows[0]!.id;
  console.log(`created series ${id} "${name}" with no source`);
  await setLink(id, path, "linked");
  await adoptFromDisk(id);
  console.log(`  it has no source, so nothing will look for new chapters until you choose one`);
  return id;
}

/**
 * Part-numbered chapters held alongside the whole chapter they split.
 *
 * A decimal is nearly always one chapter divided by a release group, so holding 25, 25.1
 * and 25.2 means reading chapter 25 twice. Those are redundant and can go.
 *
 * The ones where the whole number is NOT held are a different matter and are never
 * touched here. Checked against three sources, none of them offers the whole chapter at
 * all: Scumless Oblige has 2.1 and 2.2 and no chapter 2. Deleting those loses the chapter
 * outright, with nothing to re-fetch, so they are reported and left alone.
 */
export async function pruneSplitChapters(opts: { delete?: boolean } = {}): Promise<void> {
  const p = db();
  const rows = (await p.query<{ series_id: number; title: string; chapter_number: string; file_path: string; whole_held: boolean }>(
    `SELECT c.series_id, s.title, c.chapter_number::text, c.file_path,
            EXISTS (SELECT 1 FROM chapter c2 WHERE c2.series_id = c.series_id
                     AND c2.chapter_number = trunc(c.chapter_number)) AS whole_held
       FROM chapter c JOIN series s ON s.id = c.series_id
      WHERE c.chapter_number <> trunc(c.chapter_number)
      ORDER BY s.title, c.chapter_number`)).rows;

  const redundant = rows.filter((r) => r.whole_held);
  const orphan = rows.filter((r) => !r.whole_held);
  console.log(`${rows.length} part-numbered chapters: ${redundant.length} sit beside the whole chapter, `
    + `${orphan.length} are the only copy of theirs`);

  if (orphan.length > 0) {
    const bySeries = new Map<string, number>();
    for (const o of orphan) bySeries.set(o.title, (bySeries.get(o.title) ?? 0) + 1);
    console.log(`\nleft alone, because the whole chapter is not held and sources do not offer it:`);
    for (const [t, n] of [...bySeries.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      console.log(`  ${String(n).padStart(4)}  ${t.slice(0, 56)}`);
    }
    if (bySeries.size > 12) console.log(`  ... and ${bySeries.size - 12} more series`);
  }

  if (redundant.length === 0) return;
  let freed = 0, links = 0, gone = 0;
  for (const r of redundant) {
    if (!opts.delete) {
      try { const st = statSync(r.file_path); if (st.nlink > 1) links++; else freed += st.size; } catch { /* counted as zero */ }
      continue;
    }
    try {
      const st = statSync(r.file_path);
      if (st.nlink > 1) links++; else freed += st.size;
      rmSync(r.file_path);
    } catch { /* the row goes regardless: a missing file is not held */ }
    await p.query("DELETE FROM chapter WHERE series_id = $1 AND chapter_number = $2",
      [r.series_id, r.chapter_number]);
    await p.query("DELETE FROM wanted WHERE series_id = $1 AND chapter_number = $2",
      [r.series_id, r.chapter_number]);
    gone++;
  }
  const q = opts.delete
    ? await p.query("DELETE FROM wanted WHERE state <> 'done' AND chapter_number <> trunc(chapter_number)")
    : { rowCount: 0 };
  console.log(`\n${opts.delete ? `deleted ${gone}` : `would delete ${redundant.length}`} redundant chapters, `
    + `${(freed / 1048576).toFixed(0)}MB reclaimable`
    + (links > 0 ? `, ${links} are hardlinks the legacy folder still holds` : "")
    + ((q.rowCount ?? 0) > 0 ? `, and cleared ${q.rowCount} from the queue` : ""));
  if (!opts.delete) console.log("pass --delete to remove them");
}
