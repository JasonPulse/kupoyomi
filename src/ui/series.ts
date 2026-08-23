import { db } from "../db.js";
import { esc, page } from "./layout.js";
import { fmt, ago } from "../held.js";
import { findGaps } from "../gaps.js";

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
  // Read state is here rather than only in the reader because Paperback keeps a source's
  // read state entirely on the device: ChapterProgressManager marks a chapter complete
  // locally and never calls out. Trackers, which do call out, are a separate extension
  // type from a separate repository, so a source cannot be one.
  const readRows = (await p.query<{ chapter_number: string; completed: boolean }>(
    "SELECT chapter_number, completed FROM read_progress WHERE series_id = $1", [id])).rows;
  const readSet = new Set(readRows.filter((r) => r.completed).map((r) => fmt(r.chapter_number)));
  const readMax = readRows.filter((r) => r.completed)
    .reduce<number | null>((m, r) => Math.max(m ?? -Infinity, Number(r.chapter_number)) , null);

  const held = chapters.map((c) => Number(c.chapter_number));
  // findGaps owns this. The page used to compute it again, so the two could disagree and
  // did: only one of them knew a decimal top chapter should raise the ceiling.
  const gaps = (await findGaps(id)).missing;

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

  const chapRows = chapters.slice(0, 400).map((c) => {
    const n = fmt(c.chapter_number);
    const isRead = readSet.has(n);
    return `<tr>
    <td>ch ${n}</td>
    <td class="dim">${c.page_count ?? "-"}p</td>
    <td class="dim">${esc(c.scanlator ?? "-")}</td>
    <td class="dim">${esc(ago(c.uploaded_at, today))}</td>
    <td><button class="weak rd" data-ch="${n}" data-read="${isRead ? "1" : "0"}">${
      isRead ? "read" : "unread"}</button></td></tr>`;
  }).join("");

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
         ${bindRows || `<tr><td colspan="6" class="bad">no source bound${s.muted
           ? " (archived, which is deliberate: nothing will look for new chapters)"
           : ' &mdash; nothing will ever look for new chapters. '
             + `<a href="/search?q=${encodeURIComponent(s.title)}" style="text-decoration:none">`
             + '<button type="button">choose a source</button></a>'
         }</td></tr>`}</table>
       <div class="actions">
         <a href="/search?q=${encodeURIComponent(s.title)}" style="text-decoration:none">
           <button type="button" class="${bindings.length === 0 ? "" : "weak"}">${
             bindings.length === 0 ? "choose a source" : "migrate to another source"}</button></a>
         <span class="hint">Searches every source for this title. Adding one attaches it to this series
           rather than making a second one, and it arrives as supplemental so you can judge its real
           chapter count and range in the table above before switching. Making it primary re-scans, and
           because the ledger is keyed on chapter number, nothing already on disk is downloaded
           twice.</span></div>
       <div class="actions">
         <form method="post" action="/series/${id}/scan"><button class="weak" type="submit">check for new chapters</button></form>
         <form method="post" action="/series/${id}/metadata"><button class="weak" type="submit">refresh cover &amp; synopsis</button></form>
         <form method="post" action="/series/${id}/read" style="display:inline">
           <input type="hidden" name="chapter" value="${fmt(held[0] ?? null)}">
           <button class="weak" type="submit">mark all read</button></form>
         <a class="series" href="/series/${id}/remove" style="margin-left:auto;color:#9b3226">remove from library</a>
         ${gaps.length > 0 ? `<a class="series" href="/series/${id}/gaps">fill ${gaps.length} gaps</a>` : ""}
         <span class="hint">${gaps.length > 0
           ? `missing inside your range: ${gaps.slice(0, 18).join(", ")}${gaps.length > 18 ? " ..." : ""}`
           : "no gaps"}${
           // A run of consecutive missing chapters at the top means the source stopped
           // carrying it partway, which is a migration, not a gap fill.
           gaps.length >= 3 && gaps[gaps.length - 1] === Math.floor(Math.max(...held, 0))
             ? ". The run reaches your highest chapter, so this source stopped partway: migrating is the fix, not gap filling."
             : ""}</span>
       </div>
     </div>
     <div class="card"><div class="title">Updates</div>
       <div class="actions" style="margin:0">
         <form method="post" action="/series/${id}/mute">
           <button class="weak" type="submit">${s.muted ? "start checking again" : "stop getting updates"}</button></form>
         <span class="hint">${s.muted
           ? "Stopped. No new chapters are looked for, nothing is queued, no source is "
             + "offered to migrate to, and it will never be flagged as gone quiet. Everything "
             + "you hold stays, and it is still readable."
           : "Checked every scan for new chapters, and flagged if its source goes quiet for "
             + `${process.env["STALL_DAYS"] ?? 21} days. Stopping is for a series you have finished `
             + "or given up on: no file is deleted, and it stays readable."}</span>
       </div>
       ${wanted.length === 0 ? "" : `<div class="dim" style="margin-top:8px;font-size:12px">`
         + `${wanted.length} chapters are queued. Stopping drops them from the queue. `
         + `Starting again and checking for new chapters rebuilds whatever is still missing.`
         + `</div>`}
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
     <script>
     document.querySelectorAll('button.rd').forEach(function (b) {
       b.addEventListener('click', function () {
         var wasRead = b.dataset.read === '1';
         var url = wasRead ? '/api/pb/progress/clear' : '/api/pb/progress';
         b.disabled = true;
         fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
           body: JSON.stringify({ seriesId: SERIES_ID, chapter: b.dataset.ch, page: 0, completed: true }) })
           .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
           .then(function () {
             b.dataset.read = wasRead ? '0' : '1';
             b.textContent = wasRead ? 'unread' : 'read';
           })
           .catch(function () { b.textContent = 'failed'; })
           .then(function () { b.disabled = false; });
       });
     });
     </script>
     <script>var SERIES_ID = ${id};</script>
     <div class="card"><div class="title">Chapters</div>
       <div class="actions" style="margin:0 0 10px">
         <form method="post" action="/series/${id}/read">
           <span class="hint" style="margin:0 8px 0 0">read up to chapter</span>
           <input name="chapter" value="${readMax !== null ? fmt(String(readMax)) : ""}"
                  placeholder="${fmt(held[0] ?? null)}" style="width:80px">
           <button class="weak" type="submit">mark</button></form>
         <span class="hint">marks that chapter and everything below it read${
           readMax !== null ? `. currently read up to ${fmt(String(readMax))}` : ""}</span>
       </div>
       <table><tr><th>chapter</th><th>pages</th><th>group</th><th>uploaded</th><th></th></tr>${chapRows}</table>
       ${chapters.length > 400 ? `<div class="dim" style="margin-top:8px">showing the newest 400 of ${chapters.length}</div>` : ""}
     </div>`);
}
