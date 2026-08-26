import { db } from "../db.js";
import { esc, page, news } from "./layout.js";
import { fmt, ago } from "../held.js";

type Row = {
  id: number; title: string; status: string; muted: boolean; unbound: boolean;
  held: number; lo: string | null; hi: string | null;
  wanted: number; failed: number; source: string | null;
  last_upload: string | null; stalled_since: string | null; cover_path: string | null; ver: string;
};

const EXTRA = `
.lib{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px}
.lc{position:relative;border-radius:5px;overflow:hidden;text-decoration:none;display:block}
.lc img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;background:#1a1715}
.lc .noimg{width:100%;aspect-ratio:2/3;background:linear-gradient(160deg,#2a2438,#1b1b22);
  display:flex;align-items:center;justify-content:center;color:#544c66;font-size:11px}
.lc .t{padding:7px 8px 4px;font-size:12px;line-height:1.3;color:#dde;height:47px;overflow:hidden}
.lc .s{padding:0 8px 8px;font-size:11px;color:#8a8a95;display:flex;justify-content:space-between;gap:6px}
.lc .flag{position:absolute;top:6px;right:6px;background:rgba(0,0,0,.78);border-radius:3px;
  padding:1px 6px;font-size:10px;color:#f0d9a0;z-index:1}
.lc:hover{border-color:#6b5f9a}
.lc .pb{height:4px;background:#2a2a2a}
.lc .pb > i{display:block;height:100%;background:#2b6}
.vw{margin-bottom:12px}
.vw a{color:var(--gold);text-decoration:none;font-size:12px;margin-right:12px}
.vw a.on{color:var(--gold);font-weight:600}
`;

export async function libraryPage(q?: string, view = "grid"): Promise<string> {
  const p = db();
  const today = (await p.query<{ d: string }>("SELECT current_date::text AS d")).rows[0]?.d ?? "";
  const rows = (await p.query<Row>(
    `SELECT s.id, s.title, s.status, s.muted, s.cover_path,
            NOT EXISTS (SELECT 1 FROM series_binding b
                         WHERE b.series_id = s.id AND b.role = 'primary') AS unbound,
            count(c.chapter_number)::int AS held,
            min(c.chapter_number) AS lo, max(c.chapter_number) AS hi,
            max(c.uploaded_at)::date::text AS last_upload,
            s.stalled_since::text AS stalled_since,
            COALESCE(extract(epoch from s.metadata_at)::bigint, 0)::text AS ver,
            (SELECT b.source_name FROM series_binding b
              WHERE b.series_id = s.id AND b.role = 'primary') AS source,
            (SELECT count(*)::int FROM wanted w
              WHERE w.series_id = s.id AND w.state <> 'done') AS wanted,
            (SELECT count(*)::int FROM wanted w
              WHERE w.series_id = s.id AND w.state = 'failed' AND w.attempts >= 4) AS failed
       FROM series s LEFT JOIN chapter c ON c.series_id = s.id
      ${q ? "WHERE s.title ILIKE $1" : ""}
      GROUP BY s.id ORDER BY s.title`, q ? [`%${q}%`] : [])).rows;

  const totals = {
    series: rows.length,
    chapters: rows.reduce((a, r) => a + r.held, 0),
    wanted: rows.reduce((a, r) => a + r.wanted, 0),
    stalled: rows.filter((r) => r.stalled_since && !r.muted).length,
    // Archived series have no binding on purpose and are muted. An unmuted series with
    // no binding is stranded: nothing will ever scan it, and nothing said so.
    stranded: rows.filter((r) => r.unbound && !r.muted).length,
    sourceless: rows.filter((r) => !r.source).length,
  };
  const pct = (r: Row): number => (r.held + r.wanted > 0 ? Math.round((r.held / (r.held + r.wanted)) * 100) : 100);

  // Framed on the outside of the art: parchment panel, dark cover tiles inside it.
  const grid = news("", `<div class="lib">${rows.map((r) => `
    <a class="lc" href="/series/${r.id}">
      ${r.cover_path ? `<img loading="lazy" src="/series/${r.id}/cover?v=${r.ver}" alt="">`
                     : `<div class="noimg">no cover</div>`}
      ${r.wanted > 0 ? `<span class="flag">+${r.wanted}</span>`
        : r.unbound && !r.muted ? `<span class="flag bad">no source</span>`
        : r.stalled_since && !r.muted
          ? `<span class="flag" title="no new chapter found in the last ${process.env["STALL_DAYS"] ?? 21} days. Noticed automatically; not something you set">no updates</span>`
          : ""}
      <div class="pb"><i style="width:${pct(r)}%"></i></div>
      <div class="t">${esc(r.title)}</div>
      <div class="s"><span>${r.held} ch</span><span>${esc(r.source ?? "no source")}</span></div>
    </a>`).join("")}</div>`);

  const table = news("", `<table>
      <tr><th>series</th><th>held</th><th>queued</th><th>source</th><th>last chapter</th></tr>
      ${rows.map((r) => `<tr>
        <td><a href="/series/${r.id}">${esc(r.title)}</a>${
          r.muted ? " (muted)" : ""}${r.status === "COMPLETED" ? " (finished)" : ""}</td>
        <td>${r.held} <span class="dim">${fmt(r.lo)}&ndash;${fmt(r.hi)}</span></td>
        <td>${r.wanted > 0 ? r.wanted : '<span class="dim">-</span>'}${
          r.failed > 0 ? ` <b>(${r.failed} stuck)</b>` : ""}</td>
        <td class="dim">${esc(r.source ?? "none")}</td>
        <td class="dim">${esc(ago(r.last_upload, today))}${r.stalled_since && !r.muted ? " (quiet)" : ""}</td>
      </tr>`).join("") || '<tr><td colspan="5" class="dim">nothing matches</td></tr>'}
    </table>`);

  const link = (v: string, label: string): string =>
    `<a class="${view === v ? "on" : ""}" href="/?view=${v}${q ? `&q=${encodeURIComponent(q)}` : ""}">${label}</a>`;

  // Not a fifth tile: the row is four wide and a fifth wraps into a hole.
  return page("library", `${totals.series} series &middot; ${totals.chapters} chapters &middot; ${totals.wanted} queued${
    totals.stranded > 0 ? ` &middot; <span class="bad">${totals.stranded} with no source</span>` : ""}`,
    `<style>${EXTRA}</style>
     <div class="grid" style="margin-bottom:14px">
       <div class="tile"><div class="n">series</div><b style="font-size:20px">${totals.series}</b></div>
       <div class="tile"><div class="n">chapters held</div><b style="font-size:20px">${totals.chapters}</b></div>
       <div class="tile"><div class="n">queued</div><b style="font-size:20px">${totals.wanted}</b></div>
       <div class="tile"><div class="n">no updates found</div><b style="font-size:20px">${totals.stalled}</b></div>
     </div>
     <div class="card">
       <form method="get" action="/" style="display:flex;gap:8px;align-items:center">
         <input type="search" name="q" placeholder="filter by title" value="${esc(q ?? "")}">
         <input type="hidden" name="view" value="${esc(view)}">
         <button type="submit">filter</button>
         ${q ? '<a href="/" class="dim">clear</a>' : ""}
         <span style="margin-left:auto" class="vw">${link("grid", "covers")}${link("list", "list")}</span>
       </form>
     </div>
     ${view === "list" ? table : grid}`);
}
