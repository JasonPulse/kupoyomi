import { db } from "./db.js";
import { confirmCandidate } from "./confirm.js";
import { fmt } from "./held.js";
import { archiveCandidate } from "./archive.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#111;color:#ddd}
header{padding:14px 20px;background:#1b1b1b;border-bottom:1px solid #333;position:sticky;top:0}
h1{font-size:16px;margin:0;font-weight:600}
.sub{color:#888;font-size:12px;margin-top:3px}
main{padding:20px;max-width:1100px}
.card{background:#1a1a1a;border:1px solid #2e2e2e;border-radius:6px;margin-bottom:14px;padding:14px}
.title{font-weight:600;margin-bottom:2px}
.meta{color:#888;font-size:12px;margin-bottom:10px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;color:#888;font-weight:500;padding:4px 8px;border-bottom:1px solid #333}
td{padding:5px 8px;border-bottom:1px solid #242424;vertical-align:top}
.rec{color:#7ec699}.bad{color:#c98b7e}.dim{color:#777}
button{background:#2b6;border:0;color:#062;font-weight:600;padding:4px 10px;border-radius:4px;cursor:pointer}
button.weak{background:#444;color:#bbb}
.latest{color:#777;font-size:11px;white-space:pre-line}
a{color:#6ab}
`;

type CandRow = {
  id: number; folder: string; dead_source: string | null; file_count: number; resolved_title: string | null;
  held_count: number | null; held_lo: string | null; held_hi: string | null;
  /** Publication status the old library recorded, where it knew one. */
  status: string | null;
};
type CmpRow = {
  candidate_id: number; manga_id: number; source_name: string; source_url: string | null; chapters: number;
  range_lo: string | null; range_hi: string | null; gaps: number;
  latest: Array<{ chapter: number | null; uploaded: string; scanlator: string | null }>; note: string | null;
  new_count: number | null; lost_count: number | null; last_upload: string | null;
  new_beyond: number | null; fills_gaps: number | null; not_carried: number | null;
};

export async function reviewPage(): Promise<string> {
  const p = db();
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

  const finishedCards = finishedCands.length === 0 ? "" : `<div class="card">
    <div class="title">Finished publishing &mdash; nothing to migrate to</div>
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
    const viable = (o: CmpRow): boolean => o.chapters >= Math.max(1, heldCount * 0.5);
    const usable = opts.filter(viable);
    const best = [...usable].sort((a, b) =>
      (b.new_beyond ?? 0) - (a.new_beyond ?? 0) ||
      (b.fills_gaps ?? 0) - (a.fills_gaps ?? 0) ||
      (a.not_carried ?? 0) - (b.not_carried ?? 0))[0];

    // Same source can appear twice: sites carry duplicate entries for one series, so
    // the url is the only thing that tells them apart.
    const dupNames = new Set(opts.map((o) => o.source_name)
      .filter((n, i, a) => a.indexOf(n) !== i));

    const rows = opts.length === 0
      ? `<tr><td colspan="7" class="dim">no live source carries this &mdash; needs a wider search</td></tr>`
      : usable.length === 0
      ? `<tr><td colspan="7" class="dim">every match is a fragment of what you already hold &mdash;
           either it is finished, or it needs a wider search</td></tr>`
      : opts.map((o) => {
          const beyond = o.new_beyond ?? 0, fills = o.fills_gaps ?? 0, absent = o.not_carried ?? 0;
          const ok = viable(o);
          const good = ok && beyond > 0;
          const slug = dupNames.has(o.source_name) && o.source_url
            ? `<div class="dim" style="font-size:11px">${esc(o.source_url.slice(0, 44))}</div>` : "";
          const groups = [...new Set((o.latest ?? []).map((l) => l.scanlator).filter(Boolean))].join(", ");
          return `<tr>
            <td class="${good ? "rec" : ""}">${esc(o.source_name)}${o === best ? " &larr; best" : ""}${slug}</td>
            <td>${fmt(o.range_lo)}&ndash;${fmt(o.range_hi)} <span class="dim">(${o.chapters})</span></td>
            <td class="${beyond > 0 ? "rec" : "dim"}"><b>${beyond > 0 ? `+${beyond}` : "0"}</b></td>
            <td class="${fills > 0 ? "rec" : "dim"}">${fills > 0 ? `+${fills}` : "0"}</td>
            <td class="dim">${absent > 0 ? absent : "-"}</td>
            <td class="dim">${o.last_upload ? esc(String(o.last_upload).slice(0, 10)) : "-"}${
              groups ? `<div class="latest">${esc(groups.slice(0, 40))}</div>` : ""}</td>
            <td>${ok ? `<form method="post" action="/confirm">
              <input type="hidden" name="id" value="${k.id}">
              <input type="hidden" name="pick" value="${o.manga_id}">
              <button class="${good ? "" : "weak"}" type="submit">use this</button>
            </form>` : `<span class="dim" title="carries ${o.chapters} of your ${heldCount} chapters">fragment</span>`}</td></tr>`;
        }).join("");

    return `<div class="card">
      <div class="title">${esc(title)}</div>
      <div class="meta">${yours} &middot; stranded under ${esc(k.dead_source ?? "-")}
        <span style="margin-left:10px">${archiveButton(k.id, "finished &mdash; no migration needed")}</span></div>
      <table><tr><th>source</th><th>their range</th>
        <th title="chapters past your highest">new releases</th>
        <th title="holes inside your range this source could fill">fills gaps</th>
        <th title="chapters you hold that this source does not carry -- you keep the files either way">not carried</th>
        <th>last upload</th><th></th></tr>
      ${rows}</table></div>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Kupoyomi review</title>
    <meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body>
    <header><h1>Kupoyomi &mdash; migration review</h1>
      <div class="sub">${openCands.length} awaiting a decision &middot; ${finishedCands.length} look finished &middot; ${done?.n ?? 0} confirmed &middot;
      ledger ${led?.s ?? 0} series / ${led?.c ?? 0} chapters</div></header>
    <main>${cards || "<p class=dim>nothing awaiting confirmation.</p>"}</main></body></html>`;
}

export async function handleArchivePost(body: string): Promise<string> {
  const id = Number(new URLSearchParams(body).get("id"));
  if (!Number.isInteger(id)) throw new Error("bad form");
  await archiveCandidate(id);
  return "/";
}

export async function handleConfirmPost(body: string): Promise<string> {
  const params = new URLSearchParams(body);
  const id = Number(params.get("id"));
  const pick = Number(params.get("pick"));
  if (!Number.isInteger(id) || !Number.isInteger(pick)) throw new Error("bad form");
  await confirmCandidate(id, pick);
  return "/";
}
