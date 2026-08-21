import { db } from "../db.js";
import { esc, page } from "./layout.js";
import { fmt, ago } from "../held.js";

export async function seriesPage(id: number): Promise<string> {
  const p = db();
  const today = (await p.query<{ d: string }>("SELECT current_date::text AS d")).rows[0]?.d ?? "";
  const s = (await p.query<{ id: number; title: string; folder: string; status: string; muted: boolean; stalled_since: string | null; description: string | null; cover_path: string | null }>(
    "SELECT id, title, folder, status, muted, stalled_since::text, description, cover_path FROM series WHERE id = $1", [id])).rows[0];
  if (!s) return page("library", "not found", '<div class="card">no such series</div>');

  const bindings = (await p.query<{ id: number; source_name: string; source_url: string | null; role: string; last_checked_at: string | null }>(
    "SELECT id, source_name, source_url, role, last_checked_at::text FROM series_binding WHERE series_id = $1 ORDER BY role, source_name",
    [id])).rows;
  const chapters = (await p.query<{ chapter_number: string; scanlator: string | null; page_count: number | null; uploaded_at: string | null; file_path: string }>(
    "SELECT chapter_number, scanlator, page_count, uploaded_at::date::text AS uploaded_at, file_path FROM chapter WHERE series_id = $1 ORDER BY chapter_number DESC",
    [id])).rows;
  const wanted = (await p.query<{ chapter_number: string; state: string; attempts: number; last_error: string | null }>(
    "SELECT chapter_number, state, attempts, last_error FROM wanted WHERE series_id = $1 AND state <> 'done' ORDER BY chapter_number",
    [id])).rows;

  const held = chapters.map((c) => Number(c.chapter_number));
  const whole = new Set(held.filter(Number.isInteger));
  const gaps: number[] = [];
  if (whole.size > 0) {
    for (let i = Math.min(...whole); i <= Math.max(...whole); i++) if (!whole.has(i)) gaps.push(i);
  }

  // Availability is fetched per binding from the page, since each answer is a live
  // request to a site and four sources should not make the page wait for four.
  const bindRows = bindings.map((b) => `<tr data-binding="${b.id}">
    <td>${esc(b.source_name)} ${b.role === "primary" ? '<span class="badge">primary</span>' : '<span class="dim">supplemental</span>'}</td>
    <td class="av dim">checking</td>
    <td class="rng dim">-</td>
    <td class="nb dim">-</td>
    <td class="nc dim">-</td>
    <td>${b.role === "primary" ? "" : `<form method="post" action="/series/${id}/promote" style="display:inline">
      <input type="hidden" name="binding" value="${b.id}">
      <button class="weak" type="submit">make primary</button></form>`}</td></tr>`).join("");

  const wantRows = wanted.length === 0
    ? '<tr><td colspan="3" class="dim">nothing queued</td></tr>'
    : wanted.map((w) => `<tr>
        <td>ch ${fmt(w.chapter_number)}</td>
        <td class="${w.state === "failed" ? "bad" : "warn"}">${esc(w.state)}${w.attempts > 0 ? ` (${w.attempts} tries)` : ""}</td>
        <td class="dim" style="font-size:11px">${esc((w.last_error ?? "").slice(0, 80))}</td></tr>`).join("");

  const chapRows = chapters.slice(0, 400).map((c) => `<tr>
    <td>ch ${fmt(c.chapter_number)}</td>
    <td class="dim">${c.page_count ?? "-"}p</td>
    <td class="dim">${esc(c.scanlator ?? "-")}</td>
    <td class="dim">${esc(ago(c.uploaded_at, today))}</td></tr>`).join("");

  return page("library",
    `${chapters.length} held &middot; ${wanted.length} queued &middot; ${gaps.length} gaps`,
    `<style>.hero{display:flex;gap:18px;align-items:flex-start}
       .hero img{width:210px;height:300px;object-fit:cover;border-radius:5px;background:#242424;flex:0 0 auto}
       .hero .syn{color:#4a4034;font-size:13px;margin-top:9px;white-space:pre-wrap}</style>
     <div class="card">
       <div class="hero">
       ${s.cover_path ? `<img src="/series/${id}/cover" alt="">` : `<img alt="">`}
       <div style="min-width:0">
       <div class="title">${esc(s.title)}${s.muted ? ' <span class="badge">muted</span>' : ""}${
         s.status === "COMPLETED" ? ' <span class="badge">finished</span>' : ""}${
         s.status && s.status !== "UNKNOWN" && s.status !== "COMPLETED" ? ` <span class="badge">${esc(s.status.toLowerCase())}</span>` : ""}</div>
       <div class="meta">${chapters.length} chapters, ${fmt(held.at(-1) ?? null)}&ndash;${fmt(held[0] ?? null)}
         &middot; folder <span class="dim">${esc(s.folder)}</span>${
         s.stalled_since ? ' &middot; <span class="warn">gone quiet</span>' : ""}</div>
       ${s.description ? `<div class="syn">${esc(s.description.slice(0, 1400))}</div>` : '<div class="syn dim">no synopsis yet</div>'}
       </div></div>
       <table style="margin-top:12px" id="bindings">
         <tr><th>source</th><th>chapters</th><th>range</th>
             <th title="chapters past what you hold">new</th>
             <th title="chapters you hold that this source does not carry -- you keep the files">not carried</th><th></th></tr>
         ${bindRows || '<tr><td colspan="6" class="bad">no source bound</td></tr>'}</table>
       <div class="actions"><a class="series" href="/search?q=${encodeURIComponent(s.title)}">find another source for this series</a>
         <span class="hint">adding one from search attaches it here instead of creating a second series</span></div>
       <div class="actions">
         <form method="post" action="/series/${id}/scan"><button class="weak" type="submit">check for new chapters</button></form>
         <form method="post" action="/series/${id}/mute"><button class="weak" type="submit">${s.muted ? "unmute" : "mute"}</button></form>
         <form method="post" action="/series/${id}/metadata"><button class="weak" type="submit">refresh cover &amp; synopsis</button></form>
         <span class="hint">${gaps.length > 0 ? `missing inside your range: ${gaps.slice(0, 24).join(", ")}${gaps.length > 24 ? " ..." : ""}` : "no gaps"}</span>
       </div>
     </div>
     <div class="card"><div class="title">Queue</div>
       <table><tr><th>chapter</th><th>state</th><th>last error</th></tr>${wantRows}</table></div>
     <script>
     document.querySelectorAll('#bindings tr[data-binding]').forEach(tr => {
       fetch('/api/binding/' + tr.dataset.binding).then(r => r.json()).then(d => {
         if (d.error) { tr.querySelector('.av').innerHTML = '<span class="bad">unreachable</span>';
           tr.querySelector('.av').title = d.error; return; }
         tr.querySelector('.av').textContent = d.chapters;
         tr.querySelector('.rng').textContent = (d.lo ?? '-') + '-' + (d.hi ?? '-') + (d.gaps ? ' (' + d.gaps + ' gaps)' : '');
         const nb = tr.querySelector('.nb');
         nb.textContent = d.newBeyond > 0 ? '+' + d.newBeyond : '0';
         nb.className = 'nb ' + (d.newBeyond > 0 ? 'rec' : 'dim');
         tr.querySelector('.nc').textContent = d.notCarried || '-';
       }).catch(() => { tr.querySelector('.av').textContent = '?'; });
     });
     </script>
     <div class="card"><div class="title">Chapters</div>
       <table><tr><th>chapter</th><th>pages</th><th>group</th><th>uploaded</th></tr>${chapRows}</table>
       ${chapters.length > 400 ? `<div class="dim" style="margin-top:8px">showing the newest 400 of ${chapters.length}</div>` : ""}
     </div>`);
}
