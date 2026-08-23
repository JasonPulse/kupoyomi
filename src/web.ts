import { db } from "./db.js";
import { confirmCandidate } from "./confirm.js";
import { fmt, ago } from "./held.js";
import { archiveCandidate } from "./archive.js";
import { remap } from "./remap.js";
import { scanWanted } from "./fetch.js";

import { esc, page } from "./ui/layout.js";



type CandRow = {
  id: number; folder: string; dead_source: string | null; file_count: number; resolved_title: string | null;
  held_count: number | null; held_lo: string | null; held_hi: string | null;
  /** Publication status the old library recorded, where it knew one. */
  status: string | null;
};
type CmpRow = {
  candidate_id: number; manga_id: number; source_name: string; source_url: string | null; chapters: number;
  /** True when this candidate is the very source the files were stranded under. */
  is_original?: boolean;
  range_lo: string | null; range_hi: string | null; gaps: number;
  latest: Array<{ chapter: number | null; uploaded: string; scanlator: string | null }>; note: string | null;
  new_count: number | null; lost_count: number | null; last_upload: string | null;
  new_beyond: number | null; fills_gaps: number | null; not_carried: number | null;
};

export async function reviewPage(): Promise<string> {
  const p = db();
  // Taken from the database so the page and the data agree on what "now" is.
  const today = (await p.query<{ d: string }>("SELECT current_date::text AS d")).rows[0]?.d ?? "";
  const cands = (await p.query<CandRow>(
    `SELECT ic.id, ic.folder, ic.dead_source, ic.file_count, ic.resolved_title,
            ic.held_count, ic.held_lo, ic.held_hi, lm.status
       FROM import_candidate ic
       LEFT JOIN legacy_manga lm ON lm.suwayomi_id = ic.suwayomi_manga_id
      WHERE ic.confirmed_series_id IS NULL ORDER BY ic.file_count DESC`)).rows;
  // A source with no chapters is noise: DMCA'd entries keep the title and lose the
  // content, so they match on name and are worthless as a home.
  const cmps = (await p.query<CmpRow>(
    `SELECT candidate_id, manga_id, source_name, source_url, chapters, range_lo, range_hi, gaps,
            latest, note, new_count, lost_count, last_upload, new_beyond, fills_gaps, not_carried
       FROM candidate_comparison WHERE chapters > 0
      ORDER BY new_beyond DESC NULLS LAST, fills_gaps DESC NULLS LAST`)).rows;
  const done = (await p.query<{ n: string }>("SELECT count(*) n FROM import_candidate WHERE confirmed_series_id IS NOT NULL")).rows[0];
  const led = (await p.query<{ s: string; c: string }>(
    "SELECT (SELECT count(*) FROM series) s, (SELECT count(*) FROM chapter) c")).rows[0];

  const byCand = new Map<number, CmpRow[]>();
  for (const c of cmps) {
    const l = byCand.get(c.candidate_id);
    if (l) l.push(c); else byCand.set(c.candidate_id, [c]);
  }

  // A series the old library recorded as finished has nothing to migrate to: there
  // will be no further chapters, so every candidate can only be a fragment of what
  // is already held. Those belong in their own list, not in a migration decision.
  const finished = (s: string | null): boolean =>
    s === "COMPLETED" || s === "PUBLISHING_FINISHED" || s === "CANCELLED";
  const finishedCands = cands.filter((k) => finished(k.status));
  const openCands = cands.filter((k) => !finished(k.status));

  const archiveButton = (id: number, label: string): string =>
    `<form method="post" action="/archive" style="display:inline">
       <input type="hidden" name="id" value="${id}">
       <button class="weak" type="submit">${label}</button></form>`;

  // Only what the old library actually recorded. Anything else says so, rather than
  // leaving an action button looking like a verdict.
  const statusBadge = (st: string | null): string =>
    st && st !== "UNKNOWN" ? `<span class="badge">${esc(st.toLowerCase().replace(/_/g, " "))}</span>`
                           : `<span class="badge" style="color:#777">status unknown</span>`;

  const finishedCards = finishedCands.length === 0 ? "" : `<div class="card">
    <div class="title">Recorded as finished by the old library</div>
    <div class="meta">The old library recorded these as complete. Archiving keeps every file and
      stops them being searched, migrated or stall-alerted.</div>
    <table><tr><th>series</th><th>you hold</th><th>status</th><th></th></tr>
    ${finishedCands.map((k) => `<tr>
      <td>${esc(k.resolved_title ?? k.folder)}</td>
      <td class="dim">${k.held_count ?? k.file_count} chapters, ${fmt(k.held_lo)}&ndash;${fmt(k.held_hi)}</td>
      <td class="dim">${esc(k.status ?? "-")}</td>
      <td>${archiveButton(k.id, "archive")}</td></tr>`).join("")}
    </table></div>`;

  const cards = finishedCards + openCands.map((k) => {
    const opts = byCand.get(k.id) ?? [];
    const title = k.resolved_title ?? k.folder;
    const yours = k.held_count
      ? `you hold <b>${k.held_count}</b> chapters, ${fmt(k.held_lo)}&ndash;${fmt(k.held_hi)}`
      : `${k.file_count} files, range not yet computed`;

    // Best is the one that adds the most without losing anything. Adding chapters is
    // the point; losing chapters you already own is the thing to avoid.
    // The reason to migrate is new releases past where you are. Filling holes is a
    // bonus; a source not carrying old chapters costs nothing, since the files stay.
    // A source has to be able to serve the series, not just share its name. One
    // carrying a handful of chapters against hundreds held is a fragment: it would
    // become the binding for a run it does not have, so it is shown for information
    // and cannot be chosen.
    const heldCount = k.held_count ?? k.file_count;
    // Two independent tests. It must carry enough of the run to serve as the binding,
    // and it must actually offer something you do not have -- migrating to a source
    // with nothing newer is strictly a downgrade, which is the situation that started
    // this whole project.
    const carries = (o: CmpRow): boolean => o.chapters >= Math.max(1, heldCount * 0.5);
    const offersSomething = (o: CmpRow): boolean => (o.new_beyond ?? 0) > 0;
    const viable = (o: CmpRow): boolean => carries(o) && offersSomething(o);
    const usable = opts.filter(viable);
    // A source that went away and came back is the best possible target: the files were
    // produced by it, so its numbering matches by construction. That is a restoration,
    // not a migration, and it should not be buried among the alternatives.
    const returned = usable.find((o) => o.source_name === k.dead_source);
    // A source that reports no upload date at all comes back as the epoch. Four sources
    // tied here on every number, and the winner was decided by whatever order the rows
    // arrived in: it picked the one that could not say when it last published. Freshness
    // breaks the tie, and no date loses to any date.
    const freshness = (o: CmpRow): number => {
      const d = o.last_upload ? String(o.last_upload).slice(0, 10) : "";
      return !d || d < "1995-01-01" ? -1 : Date.parse(d);
    };
    const best = returned ?? [...usable].sort((a, b) =>
      (b.new_beyond ?? 0) - (a.new_beyond ?? 0) ||
      (b.fills_gaps ?? 0) - (a.fills_gaps ?? 0) ||
      (a.not_carried ?? 0) - (b.not_carried ?? 0) ||
      freshness(b) - freshness(a) ||
      a.source_name.localeCompare(b.source_name))[0];

    // Same source can appear twice: sites carry duplicate entries for one series, so
    // the url is the only thing that tells them apart.
    const dupNames = new Set(opts.map((o) => o.source_name)
      .filter((n, i, a) => a.indexOf(n) !== i));

    const rows = opts.length === 0
      ? `<tr><td colspan="7" class="dim">no live source carries this &mdash; needs a wider search</td></tr>`
      : usable.length === 0
      ? `<tr><td colspan="7" class="dim">no source offers anything past chapter ${fmt(k.held_hi)} &mdash;
           staying put is better than migrating. Either it is finished, or it needs a wider search.</td></tr>`
      : opts.map((o) => {
          const beyond = o.new_beyond ?? 0, fills = o.fills_gaps ?? 0, absent = o.not_carried ?? 0;
          const ok = viable(o);
          const good = ok && beyond > 0;
          const slug = dupNames.has(o.source_name) && o.source_url
            ? `<div class="dim" style="font-size:11px">${esc(o.source_url.slice(0, 44))}</div>` : "";
          const groups = [...new Set((o.latest ?? []).map((l) => l.scanlator).filter(Boolean))].join(", ");
          return `<tr>
            <td class="${good ? "rec" : ""}">${esc(o.source_name)}${
              o.source_name === k.dead_source ? ' <span class="badge">original source, back</span>'
                : o === best ? " &larr; best" : ""}${slug}</td>
            <td>${fmt(o.range_lo)}&ndash;${fmt(o.range_hi)} <span class="dim">(${o.chapters}${
              // Without this, a source reaching chapter 71 with 30 holes in it looks
              // better than one that stops at 42 and is complete. The range is not the
              // measure; what it actually carries is.
              (o.gaps ?? 0) > 0 ? `, ${o.gaps} missing` : ""})</span></td>
            <td class="${beyond > 0 ? "rec" : "dim"}"><b>${beyond > 0 ? `+${beyond}` : "0"}</b></td>
            <td class="${fills > 0 ? "rec" : "dim"}">${fills > 0 ? `+${fills}` : "0"}</td>
            <td class="dim">${absent > 0 ? absent : "-"}</td>
            <td class="dim">${esc(ago(o.last_upload, today))}${
              groups ? `<div class="latest">${esc(groups.slice(0, 40))}</div>` : ""}</td>
            <td>${ok ? `<form method="post" action="/confirm">
              <input type="hidden" name="id" value="${k.id}">
              <input type="hidden" name="pick" value="${o.manga_id}">
              <button class="${good ? "" : "weak"}" type="submit">use this</button>
            </form>` : `<span class="dim" title="${carries(o)
                ? `carries ${o.chapters} chapters but nothing past your ${fmt(k.held_hi)}`
                : `carries only ${o.chapters} of your ${heldCount} chapters`}">${
                carries(o) ? "nothing newer" : "fragment"}</span>`}</td></tr>`;
        }).join("");

    return `<div class="card">
      <div class="title">${esc(title)} ${statusBadge(k.status)}</div>
      <div class="meta">${yours} &middot; stranded under ${esc(k.dead_source ?? "-")}${
        returned ? ' &middot; <span class="rec">that source is installable again, so re-binding to it restores the run exactly</span>' : ""}</div>
      <table><tr><th>source</th><th>their range</th>
        <th title="chapters past your highest">new releases</th>
        <th title="holes inside your range this source could fill">fills gaps</th>
        <th title="chapters you hold that this source does not carry -- you keep the files either way">not carried</th>
        <th>last upload</th><th></th></tr>
      ${rows}</table>
      <div class="actions">${archiveButton(k.id, "mark as finished")}
        <span class="hint">no more chapters coming: keep every file, bind no source, stop asking</span>
      </div></div>`;
  }).join("");

  return page("review",
    `${openCands.length} awaiting a decision &middot; ${finishedCands.length} look finished &middot; ${done?.n ?? 0} confirmed`,
    cards || '<div class="card dim">nothing awaiting confirmation.</div>');
}

export async function handleArchivePost(body: string): Promise<string> {
  const id = Number(new URLSearchParams(body).get("id"));
  if (!Number.isInteger(id)) throw new Error("bad form");
  await archiveCandidate(id);
  // Back to the list, not the library. Working through a queue of twelve means twelve
  // trips back here, and every one of them was a manual navigation.
  return "/review";
}

export async function handleConfirmPost(body: string): Promise<string> {
  const params = new URLSearchParams(body);
  const id = Number(params.get("id"));
  const pick = Number(params.get("pick"));
  if (!Number.isInteger(id) || !Number.isInteger(pick)) throw new Error("bad form");
  await confirmCandidate(id, pick);
  // Adopt the stranded files before anything scans.
  //
  // confirmCandidate only records the binding and prints "will be adopted on the next
  // remap", and remap was a CLI command nobody ran. So the scheduler's next scan found
  // an empty ledger and queued the whole series: Noble in Name, Vulgar at Heart had 44
  // chapters on disk and 50 queued for download. Awaited, because a scan that starts
  // first sees no chapters and queues all of them.
  const sid = (await db().query<{ n: number | null }>(
    "SELECT confirmed_series_id AS n FROM import_candidate WHERE id = $1", [id])).rows[0]?.n;
  if (sid) {
    await remap(sid).catch((e: unknown) => {
      console.log(`remap after confirm failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    // Now the ledger knows what is held, so this queues only what is genuinely missing.
    void scanWanted({ seriesId: sid }).catch(() => undefined);
  }
  return "/review";
}
