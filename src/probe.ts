import { db } from "./db.js";
import { gql, installedExtensions, installExtension, sanitize } from "./suwayomi.js";
import type { Candidate } from "./match.js";

type SourceWithExt = { id: string; displayName: string; lang: string; isNsfw: boolean; extension: { pkgName: string } | null };

const sourcesWithExtension = async (): Promise<SourceWithExt[]> =>
  (await gql<{ sources: { nodes: SourceWithExt[] } }>(
    `{ sources { nodes { id displayName lang isNsfw extension { pkgName } } } }`)).sources.nodes;

const SEARCH = `mutation($src:LongString!,$q:String!){
  fetchSourceManga(input:{source:$src,type:SEARCH,query:$q,page:1}){ mangas{ id title url } } }`;

const uninstall = async (pkgName: string): Promise<void> => {
  await gql(`mutation($pkg:String!){ updateExtension(input:{id:$pkg,patch:{uninstall:true}}){ clientMutationId } }`,
    { pkg: pkgName });
};

type Target = { id: number; folder: string; title: string; candidates: Candidate[] };

/**
 * Widens the search for series no live source carries.
 *
 * Browsing 538 extension names tells you nothing about who carries your series, so
 * this installs them in batches, searches every unresolved title while they are live,
 * keeps the extensions that hit and removes the rest. Amortising all the titles across
 * one install is what makes it affordable.
 */
export async function probe(opts: { batch?: number; max?: number; includeNsfw?: boolean } = {}): Promise<void> {
  const batchSize = opts.batch ?? 12;
  const p = db();

  const targets = (await p.query<Target>(
    `SELECT id, folder, COALESCE(resolved_title, folder) AS title, candidates
       FROM import_candidate WHERE confirmed_series_id IS NULL ORDER BY file_count DESC`)).rows;
  if (targets.length === 0) { console.log("nothing unresolved to search for"); return; }
  console.log(`searching for ${targets.length} series`);

  const tried = new Set((await p.query<{ pkg_name: string }>("SELECT pkg_name FROM probe_attempt")).rows.map((r) => r.pkg_name));
  const installed = new Set((await installedExtensions()).map((e) => e.pkgName));

  const all = (await gql<{ extensions: { nodes: Array<{ pkgName: string; name: string; lang: string; isNsfw: boolean }> } }>(
    `{ extensions { nodes { pkgName name lang isNsfw } } }`)).extensions.nodes;
  let pool = all.filter((e) => (e.lang === "en" || e.lang === "all")
    && !installed.has(e.pkgName) && !tried.has(e.pkgName));
  if (opts.includeNsfw === false) pool = pool.filter((e) => !e.isNsfw);
  if (opts.max) pool = pool.slice(0, opts.max);
  console.log(`${pool.length} extensions left to try, in batches of ${batchSize}\n`);

  const knownSources = new Set((await sourcesWithExtension()).map((s) => s.id));

  for (let i = 0; i < pool.length; i += batchSize) {
    const batch = pool.slice(i, i + batchSize);
    const ok: string[] = [];
    for (const e of batch) {
      try { await installExtension(e.pkgName); ok.push(e.pkgName); }
      catch (err) {
        await p.query("INSERT INTO probe_attempt (pkg_name, error) VALUES ($1,$2) ON CONFLICT (pkg_name) DO NOTHING",
          [e.pkgName, err instanceof Error ? err.message.slice(0, 200) : String(err)]);
      }
    }
    // Whatever those extensions brought with them that we have not searched before.
    const fresh = (await sourcesWithExtension()).filter(
      (s) => !knownSources.has(s.id) && (s.lang === "en" || s.lang === "all"));
    for (const s of fresh) knownSources.add(s.id);

    const hitsPerPkg = new Map<string, number>();
    for (const src of fresh) {
      for (const t of targets) {
        let hits: Array<{ id: number; title: string; url: string }>;
        try {
          hits = (await gql<{ fetchSourceManga: { mangas: Array<{ id: number; title: string; url: string }> } }>(
            SEARCH, { src: src.id, q: t.title })).fetchSourceManga.mangas;
        } catch { continue; }
        for (const m of hits) {
          if (m.title !== t.title && sanitize(m.title) !== t.folder) continue;   // exact only
          if (t.candidates.some((c) => c.sourceId === src.id && c.url === m.url)) continue;
          t.candidates.push({
            sourceName: src.displayName, sourceId: src.id, mangaId: m.id, url: m.url,
            title: m.title, matched: m.title === t.title ? "title" : "sanitized",
          });
          await p.query("UPDATE import_candidate SET candidates = $1 WHERE id = $2",
            [JSON.stringify(t.candidates), t.id]);
          console.log(`  HIT  ${src.displayName.padEnd(24)} ${t.title.slice(0, 42)}`);
          // Credit the extension that actually provided this source. Crediting the
          // whole batch kept 60 of 66 extensions on 156 "hits" that mostly belonged
          // to a handful of them.
          const owner = src.extension?.pkgName;
          if (owner) hitsPerPkg.set(owner, (hitsPerPkg.get(owner) ?? 0) + 1);
        }
      }
    }

    // Keep only what earned its place. Every installed extension widens the fan-out of
    // every future global search, so carrying 500 of them would make search unusable.
    for (const pkg of ok) {
      const hits = hitsPerPkg.get(pkg) ?? 0;
      const keep = hits > 0;
      if (!keep) { try { await uninstall(pkg); } catch { /* leaving it installed is harmless */ } }
      else await p.query(
        `INSERT INTO extension (pkg_name, desired) VALUES ($1,true)
         ON CONFLICT (pkg_name) DO UPDATE SET desired = true`, [pkg]);
      await p.query(
        `INSERT INTO probe_attempt (pkg_name, sources, hits, kept) VALUES ($1,$2,$3,$4)
         ON CONFLICT (pkg_name) DO UPDATE SET sources=$2, hits=$3, kept=$4, probed_at=now()`,
        [pkg, fresh.length, hits, keep]);
    }
    console.log(`batch ${Math.floor(i / batchSize) + 1}: ${ok.length} installed, ${fresh.length} new sources searched, kept ${[...hitsPerPkg.keys()].length}`);
  }

  const still = (await p.query<{ n: string }>(
    `SELECT count(*) n FROM import_candidate
      WHERE confirmed_series_id IS NULL AND jsonb_array_length(candidates) = 0`)).rows[0];
  console.log(`\nstill with no candidate at all: ${still?.n ?? "?"} of ${targets.length}`);
}


/**
 * Removes extensions the probe installed that nothing actually references.
 *
 * A hit-attribution bug credited every extension in a batch for any hit, so 60 of 66
 * were kept. Every installed extension widens the fan-out of every global search, so
 * the installed set has to be exactly what is referenced by a binding or a candidate.
 * Only extensions the probe itself installed are touched.
 */
export async function tidyExtensions(opts: { dryRun?: boolean } = {}): Promise<void> {
  const p = db();
  const sources = await sourcesWithExtension();
  const byId = new Map(sources.map((s) => [s.id, s]));

  const referenced = new Set<string>();
  for (const r of (await p.query<{ source_id: string }>("SELECT DISTINCT source_id FROM series_binding")).rows) {
    referenced.add(r.source_id);
  }
  for (const r of (await p.query<{ candidates: Candidate[] }>("SELECT candidates FROM import_candidate")).rows) {
    for (const c of r.candidates) referenced.add(c.sourceId);
  }
  const neededPkgs = new Set(
    [...referenced].map((id) => byId.get(id)?.extension?.pkgName).filter((x): x is string => !!x));

  const probed = (await p.query<{ pkg_name: string; kept: boolean }>(
    "SELECT pkg_name, kept FROM probe_attempt WHERE kept")).rows;
  const drop = probed.filter((r) => !neededPkgs.has(r.pkg_name));

  console.log(`${referenced.size} sources referenced, needing ${neededPkgs.size} extensions`);
  console.log(`${probed.length} kept by the probe, ${drop.length} of those referenced by nothing`);
  if (opts.dryRun || drop.length === 0) return;

  for (const r of drop) {
    try {
      await gql(`mutation($pkg:String!){ updateExtension(input:{id:$pkg,patch:{uninstall:true}}){ clientMutationId } }`,
        { pkg: r.pkg_name });
    } catch { /* already gone is fine */ }
    await p.query("UPDATE probe_attempt SET kept = false WHERE pkg_name = $1", [r.pkg_name]);
    await p.query("UPDATE extension SET desired = false WHERE pkg_name = $1", [r.pkg_name]);
  }
  const after = await sourcesWithExtension();
  console.log(`uninstalled ${drop.length}; sources now ${after.length}`);
}
