import { db } from "./db.js";

/**
 * Sources behind a paid subscription, which cannot be downloaded from and must never be
 * offered as a home for a series.
 *
 * Manta cost this library 99 chapters of a six-page purchase notice, all recorded as
 * successful downloads. The damage is not the wasted bytes, it is that the ledger then
 * believes chapter 4 is held, so the next source's real chapter 4 is skipped as already
 * present. A paid source is worse than no source.
 *
 * The list is data rather than code so a new one can be added without a deploy, and it
 * matches on source name because a name is stable across Suwayomi instances while the
 * numeric source id is not.
 */
let cache: RegExp | null = null;

export async function paidPattern(): Promise<RegExp> {
  if (cache) return cache;
  const rows = (await db().query<{ pattern: string }>("SELECT pattern FROM paid_source")).rows;
  // An empty list must never produce a regex that matches everything.
  cache = rows.length === 0
    ? /(?!)/
    : new RegExp(rows.map((r) => r.pattern).join("|"), "i");
  return cache;
}

/** Forgets the compiled list, for when a row has just been added. */
export const forgetPaid = (): void => { cache = null; };

export const isPaidSource = async (name: string): Promise<boolean> =>
  (await paidPattern()).test(name);

/** Which of these source names are paid, as a set, for filtering a list in one pass. */
export async function paidAmong(names: string[]): Promise<Set<string>> {
  const re = await paidPattern();
  return new Set(names.filter((n) => re.test(n)));
}

export type PaidBinding = {
  seriesId: number; title: string; sourceName: string; role: string; held: number;
};

/** Series currently bound to a paid source, which need a different home. */
export async function paidBindings(): Promise<PaidBinding[]> {
  const re = await paidPattern();
  const rows = (await db().query<{ series_id: number; title: string; source_name: string; role: string; held: string }>(
    `SELECT b.series_id, s.title, b.source_name, b.role,
            (SELECT count(*) FROM chapter c WHERE c.series_id = b.series_id)::text AS held
       FROM series_binding b JOIN series s ON s.id = b.series_id
      ORDER BY s.title`)).rows;
  return rows.filter((r) => re.test(r.source_name)).map((r) => ({
    seriesId: r.series_id, title: r.title, sourceName: r.source_name,
    role: r.role, held: Number(r.held),
  }));
}

/**
 * The sources worth searching: installed, English or multi-language, and not paid.
 *
 * One place, so a paid source cannot leak back in through whichever surface someone
 * forgets. installedSources() itself stays truthful, because the extensions page and the
 * snapshot need to see everything that is actually installed.
 */
export async function usableSources(): Promise<Array<{ id: string; displayName: string; lang: string; isNsfw: boolean; supportsLatest: boolean }>> {
  const { installedSources } = await import("./suwayomi.js");
  const re = await paidPattern();
  return (await installedSources())
    .filter((s) => s.lang === "en" || s.lang === "all")
    .filter((s) => !re.test(s.displayName));
}

/**
 * Uninstalls the extensions behind paid sources and reports what was bound to them.
 *
 * Marked undesired as well as uninstalled, so the boot reconciler does not put them back
 * on the next cold start. Their series keep every file: what is deleted is the binding,
 * because a binding to a paid source only ever produces purchase notices.
 */
export async function purgePaidSources(opts: { dryRun?: boolean } = {}): Promise<void> {
  const { installedSources } = await import("./suwayomi.js");
  const { gql } = await import("./suwayomi.js");
  const re = await paidPattern();
  const paid = (await installedSources()).filter((s) => re.test(s.displayName));

  const bound = await paidBindings();
  console.log(`${paid.length} installed source${paid.length === 1 ? "" : "s"} are paid subscriptions`);
  for (const s of paid) console.log(`  ${s.displayName}`);
  if (bound.length > 0) {
    console.log(`${bound.length} binding${bound.length === 1 ? "" : "s"} point at one:`);
    for (const b of bound) {
      console.log(`  series ${b.seriesId} ${b.title.slice(0, 44)} via ${b.sourceName} (${b.role}, ${b.held} held)`);
    }
  }
  if (opts.dryRun) { console.log("[dry run] nothing changed"); return; }

  // Extensions, not sources: one extension can ship several language variants.
  const pkgs = (await gql<{ extensions: { nodes: Array<{ pkgName: string; name: string }> } }>(
    `{ extensions(condition:{isInstalled:true}) { nodes { pkgName name } } }`)).extensions.nodes
    .filter((e) => re.test(e.name) || re.test(e.pkgName));
  for (const e of pkgs) {
    await gql(`mutation($pkg:String!){ updateExtension(input:{id:$pkg,patch:{uninstall:true}}){ clientMutationId } }`,
      { pkg: e.pkgName }).catch((err: unknown) => {
        console.log(`  could not uninstall ${e.pkgName}: ${err instanceof Error ? err.message : String(err)}`);
      });
    await db().query("UPDATE extension SET desired = false WHERE pkg_name = $1", [e.pkgName]);
    console.log(`  uninstalled ${e.name} (${e.pkgName})`);
  }
  console.log(`${pkgs.length} extension${pkgs.length === 1 ? "" : "s"} uninstalled and marked undesired`);
}
