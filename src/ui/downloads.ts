import { db } from "../db.js";
import { esc, page, news } from "./layout.js";
import { fmt } from "../held.js";

export type Live = {
  active: Array<{ title: string; seriesId: number; chapter: string; done: number | null; total: number | null; secs: number }>;
  recent: Array<{ title: string; seriesId: number; chapter: string; ago: number;
    ok: boolean; error: string | null; retryIn: number | null }>;
  stuck: Array<{ title: string; seriesId: number; chapter: string; attempts: number; error: string | null }>;
  counts: { pending: number; fetching: number; failed: number; done: number };
  rate: { lastHour: number; lastDay: number };
};

export async function liveState(): Promise<Live> {
  const p = db();
  const active = (await p.query<{ title: string; series_id: number; chapter_number: string; pages_done: number | null; pages_total: number | null; secs: string }>(
    `SELECT s.title, w.series_id, w.chapter_number, w.pages_done, w.pages_total,
            EXTRACT(EPOCH FROM (now() - w.started_at))::int::text AS secs
       FROM wanted w JOIN series s ON s.id = w.series_id
      WHERE w.state = 'fetching' ORDER BY w.started_at`)).rows;
  // Failures belong here beside the successes. A chapter that had just failed appeared
  // in none of these three lists: not in flight, not done, and short of the attempt limit
  // so not given up either. Press retry, watch it fail, and it vanishes off the page you
  // are looking at, which is exactly what "the chapter disappeared" was.
  const recent = (await p.query<{ title: string; series_id: number; chapter_number: string; ago: string; ok: boolean; last_error: string | null; retry_in: string | null }>(
    `SELECT s.title, w.series_id, w.chapter_number,
            EXTRACT(EPOCH FROM (now() - COALESCE(w.finished_at, w.started_at)))::int::text AS ago,
            (w.state = 'done') AS ok, w.last_error,
            CASE WHEN w.retry_after > now()
                 THEN EXTRACT(EPOCH FROM (w.retry_after - now()))::int::text END AS retry_in
       FROM wanted w JOIN series s ON s.id = w.series_id
      WHERE (w.state = 'done' AND w.finished_at IS NOT NULL)
         OR (w.state = 'failed' AND w.started_at > now() - interval '6 hours')
      ORDER BY COALESCE(w.finished_at, w.started_at) DESC LIMIT 16`)).rows;
  const stuck = (await p.query<{ title: string; series_id: number; chapter_number: string; attempts: number; last_error: string | null }>(
    `SELECT s.title, w.series_id, w.chapter_number, w.attempts, w.last_error
       FROM wanted w JOIN series s ON s.id = w.series_id
      WHERE w.state = 'failed' AND w.attempts >= ${Math.max(1, Number(process.env["FETCH_MAX_ATTEMPTS"] ?? 6))}
      ORDER BY s.title LIMIT 12`)).rows;
  const c = (await p.query<{ state: string; n: string }>("SELECT state, count(*) n FROM wanted GROUP BY state")).rows;
  const at = (st: string): number => Number(c.find((x) => x.state === st)?.n ?? 0);
  const rate = (await p.query<{ h: string; d: string }>(
    `SELECT count(*) FILTER (WHERE finished_at > now() - interval '1 hour') AS h,
            count(*) FILTER (WHERE finished_at > now() - interval '1 day')  AS d
       FROM wanted WHERE state = 'done'`)).rows[0];

  return {
    active: active.map((r) => ({ title: r.title, seriesId: r.series_id, chapter: r.chapter_number,
      done: r.pages_done, total: r.pages_total, secs: Number(r.secs) })),
    recent: recent.map((r) => ({ title: r.title, seriesId: r.series_id, chapter: r.chapter_number,
      ago: Number(r.ago), ok: r.ok, error: r.last_error,
      retryIn: r.retry_in === null ? null : Number(r.retry_in) })),
    stuck: stuck.map((r) => ({ title: r.title, seriesId: r.series_id, chapter: r.chapter_number,
      attempts: r.attempts, error: r.last_error })),
    counts: { pending: at("pending"), fetching: at("fetching"), failed: at("failed"), done: at("done") },
    rate: { lastHour: Number(rate?.h ?? 0), lastDay: Number(rate?.d ?? 0) },
  };
}

/**
 * The FFXI news-window frame the artwork was made for: a parchment panel with ornate
 * ends. Deliberately light against the dark app, because that is what the images are.
 */
const FRAME = `
.pbar{height:6px;background:rgba(0,0,0,.15);border-radius:3px;overflow:hidden;min-width:90px}
.pbar > i{display:block;height:100%;background:linear-gradient(180deg,#d8ae63,#a8863f)}
.tile-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px}
@media(max-width:900px){.tile-row{grid-template-columns:repeat(2,1fr)}}
`;


export async function downloadsPage(): Promise<string> {
  const s = await liveState();
  return page("downloads",
    `${s.counts.fetching} downloading &middot; ${s.counts.pending} queued &middot; ${s.rate.lastHour}/hr`,
    `<style>${FRAME}</style>
     <div class="tile-row">
       <div class="tile"><div class="n">downloading</div><b style="font-size:20px" id="t-active">${s.counts.fetching}</b></div>
       <div class="tile"><div class="n">queued</div><b style="font-size:20px" id="t-pending">${s.counts.pending}</b></div>
       <div class="tile"><div class="n">done, last hour</div><b style="font-size:20px" id="t-hour">${s.rate.lastHour}</b></div>
       <div class="tile"><div class="n">done, last day</div><b style="font-size:20px" id="t-day">${s.rate.lastDay}</b>
         <span class="n" id="t-stuck-wrap"> &middot; <span id="t-stuck">${s.stuck.length}</span> out of attempts</span></div>
     </div>
     ${news("Downloading now", '<div id="active"></div>')}
     ${news("Recently attempted", '<div id="recent"></div>')}
     <div class="card"><div class="title">Out of attempts, waiting for another try</div><div id="stuck"></div></div>
     <script>
     function rel(s){ return s<60 ? s+'s ago' : s<3600 ? Math.round(s/60)+'m ago' : Math.round(s/3600)+'h ago'; }
     function paint(d){
       document.getElementById('t-active').textContent = d.counts.fetching;
       document.getElementById('t-pending').textContent = d.counts.pending;
       document.getElementById('t-hour').textContent = d.rate.lastHour;
       document.getElementById('t-day').textContent = d.rate.lastDay;
       document.getElementById('t-stuck').textContent = d.stuck.length;
       document.getElementById('active').innerHTML = d.active.length === 0
         ? '<div style="color:var(--ink-dim)">nothing in flight — the scheduler fetches a batch every 15 minutes</div>'
         : '<table><tr><th>series</th><th>chapter</th><th>pages</th><th>elapsed</th></tr>' + d.active.map(a =>
             '<tr><td><a href="/series/'+a.seriesId+'" class="series">'+a.title+'</a></td>'+
             '<td>ch '+a.chapter+'</td>'+
             '<td><div class="pbar"><i style="width:'+(a.total?Math.round(100*a.done/a.total):0)+'%"></i></div>'+
               '<span style="font-size:11px;color:var(--ink-dim)">'+(a.done||0)+'/'+(a.total||'?')+'</span></td>'+
             '<td>'+a.secs+'s</td></tr>').join('') + '</table>';
       document.getElementById('recent').innerHTML = d.recent.length === 0
         ? '<div style="color:var(--ink-dim)">nothing yet</div>'
         : '<table><tr><th>series</th><th>chapter</th><th>when</th><th>result</th></tr>' + d.recent.map(r =>
             '<tr><td><a href="/series/'+r.seriesId+'" class="series">'+r.title+'</a></td>'+
             '<td>ch '+r.chapter+'</td><td>'+rel(r.ago)+'</td>'+
             '<td class="'+(r.ok?'rec':'bad')+'" style="font-size:11.5px">'+
               (r.ok ? 'done'
                     : (r.error||'failed').slice(0,52) +
                       (r.retryIn ? ' <span class="dim">retrying in '+
                         (r.retryIn<3600 ? Math.round(r.retryIn/60)+'m' : Math.round(r.retryIn/3600)+'h')+'</span>'
                                  : ''))+
             '</td></tr>').join('') + '</table>';
       document.getElementById('stuck').innerHTML = d.stuck.length === 0
         ? '<div class="dim">none</div>'
         : '<table><tr><th>series</th><th>chapter</th><th>tries</th><th>error</th></tr>' + d.stuck.map(r =>
             '<tr><td><a class="series" href="/series/'+r.seriesId+'">'+r.title+'</a></td>'+
             '<td>ch '+r.chapter+'</td><td>'+r.attempts+'</td>'+
             '<td class="dim" style="font-size:11px">'+(r.error||'').slice(0,90)+'</td></tr>').join('') + '</table>';
     }
     paint(${JSON.stringify(s)});
     setInterval(() => fetch('/api/live').then(r=>r.json()).then(paint).catch(()=>{}), 4000);
     </script>`);
}
