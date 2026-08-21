import { db } from "../db.js";
import { esc, page } from "./layout.js";
import { fmt, ago } from "../held.js";

type Row = {
  id: number; title: string; status: string; muted: boolean;
  held: number; lo: string | null; hi: string | null; gaps: number;
  wanted: number; failed: number; source: string | null;
  last_upload: string | null; stalled_since: string | null;
};

export async function libraryPage(q?: string): Promise<string> {
  const p = db();
  const today = (await p.query<{ d: string }>("SELECT current_date::text AS d")).rows[0]?.d ?? "";
  const rows = (await p.query<Row>(
    `SELECT s.id, s.title, s.status, s.muted,
            count(c.chapter_number)::int                                       AS held,
            min(c.chapter_number)                                              AS lo,
            max(c.chapter_number)                                              AS hi,
            max(c.uploaded_at)::date::text                                     AS last_upload,
            s.stalled_since::text                                              AS stalled_since,
            (SELECT b.source_name FROM series_binding b
              WHERE b.series_id = s.id AND b.role = 'primary')                 AS source,
            (SELECT count(*)::int FROM wanted w
              WHERE w.series_id = s.id AND w.state <> 'done')                  AS wanted,
            (SELECT count(*)::int FROM wanted w
              WHERE w.series_id = s.id AND w.state = 'failed' AND w.attempts >= 4) AS failed,
            0 AS gaps
       FROM series s LEFT JOIN chapter c ON c.series_id = s.id
      ${q ? "WHERE s.title ILIKE $1" : ""}
      GROUP BY s.id ORDER BY s.title`, q ? [`%${q}%`] : [])).rows;

  const totals = {
    series: rows.length,
    chapters: rows.reduce((a, r) => a + r.held, 0),
    wanted: rows.reduce((a, r) => a + r.wanted, 0),
    stalled: rows.filter((r) => r.stalled_since && !r.muted).length,
    sourceless: rows.filter((r) => !r.source).length,
  };

  const tiles = `<div class="grid" style="margin-bottom:14px">
    <div class="tile"><div class="n">series</div><b style="font-size:20px">${totals.series}</b></div>
    <div class="tile"><div class="n">chapters held</div><b style="font-size:20px">${totals.chapters}</b></div>
    <div class="tile"><div class="n">queued to download</div><b style="font-size:20px">${totals.wanted}</b></div>
    <div class="tile"><div class="n">gone quiet</div><b style="font-size:20px">${totals.stalled}</b></div>
    <div class="tile"><div class="n">no source</div><b style="font-size:20px">${totals.sourceless}</b></div>
  </div>`;

  const body = rows.map((r) => {
    const pct = r.held + r.wanted > 0 ? Math.round((r.held / (r.held + r.wanted)) * 100) : 100;
    return `<tr>
      <td><a class="series" href="/series/${r.id}">${esc(r.title)}</a>${
        r.muted ? ' <span class="badge">muted</span>' : ""}${
        r.status === "COMPLETED" ? ' <span class="badge">finished</span>' : ""}</td>
      <td>${r.held} <span class="dim">${fmt(r.lo)}&ndash;${fmt(r.hi)}</span></td>
      <td>${r.wanted > 0 ? `<span class="warn">${r.wanted}</span>` : '<span class="dim">-</span>'}${
        r.failed > 0 ? ` <span class="bad">(${r.failed} stuck)</span>` : ""}</td>
      <td><div class="bar"><i style="width:${pct}%"></i></div></td>
      <td class="dim">${r.source ? esc(r.source) : '<span class="bad">none</span>'}</td>
      <td class="dim">${esc(ago(r.last_upload, today))}${
        r.stalled_since && !r.muted ? ' <span class="warn">quiet</span>' : ""}</td>
    </tr>`;
  }).join("");

  return page("library", `${totals.series} series &middot; ${totals.chapters} chapters &middot; ${totals.wanted} queued`,
    `${tiles}
     <div class="card">
       <form method="get" action="/" style="margin-bottom:10px">
         <input type="search" name="q" placeholder="filter the library by title" value="${esc(q ?? "")}">
         <button type="submit">filter</button>
         ${q ? '<a href="/" class="dim" style="margin-left:8px">clear</a>' : ""}
       </form>
       <table><tr><th>series</th><th>held</th><th>queued</th><th>complete</th><th>source</th><th>last chapter</th></tr>
       ${body || '<tr><td colspan="6" class="dim">nothing matches</td></tr>'}</table>
     </div>`);
}
