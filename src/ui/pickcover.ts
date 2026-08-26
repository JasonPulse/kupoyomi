import { esc, page } from "./layout.js";
import { coverCandidates } from "../metadata.js";
import { db } from "../db.js";

/**
 * A page of thumbnails to choose a cover from.
 *
 * Six imported series took a credits page or a wall of panels as their cover, because a
 * comic page and a cover are the same shape and nothing reading bytes can tell them
 * apart. Looking at ten thumbnails settles it in a second.
 */
export async function pickCoverPage(seriesId: number): Promise<string> {
  const s = (await db().query<{ title: string; cover_path: string | null }>(
    "SELECT title, cover_path FROM series WHERE id = $1", [seriesId])).rows[0];
  if (!s) return page("library", "not found", '<div class="card">no such series</div>');
  const chapters = await coverCandidates(seriesId);

  const grid = chapters.map((c) => `<div class="title" style="margin-top:8px">chapter ${esc(c.chapter.replace(/\.?0+$/, "") || c.chapter)}</div>
    <div class="pg">${Array.from({ length: c.pages }, (_, i) => `
      <form method="post" action="/series/${seriesId}/cover">
        <input type="hidden" name="chapter" value="${esc(c.chapter)}">
        <input type="hidden" name="index" value="${i}">
        <button type="submit" class="pick" title="use page ${i + 1} of chapter ${esc(c.chapter)}">
          <img loading="lazy" src="/api/pb/page/${seriesId}/${encodeURIComponent(c.chapter)}/${i}">
          <span>p${i + 1}</span>
        </button></form>`).join("")}</div>`).join("");

  return page("library", `cover for ${s.title}`,
    `<style>
       .pg{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:6px}
       @media(max-width:700px){.pg{grid-template-columns:repeat(3,1fr)}}
       .pick{padding:0;background:none;border:1px solid rgba(227,182,97,.25);border-image:none;border-radius:2px;overflow:hidden;
         display:block;width:100%;cursor:pointer;white-space:normal}
       .pick img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;background:#1a1715}
       .pick span{display:block;font-size:11px;color:var(--ink-dim);background:rgba(0,0,0,.55);padding:3px 0}
       .pick:hover{border-color:var(--gold);filter:none}
       .cur{width:120px;height:172px;object-fit:cover;border-radius:4px;background:#1a1715}
     </style>
     <div class="card">
       <div class="title">${esc(s.title)}</div>
       <div class="meta">Shape cannot tell a cover from a page of panels, so pick one. It is copied
         to cover.jpg in the series folder, which is where any other reader looks for it too.</div>
       <div class="actions">
         ${s.cover_path ? `<img class="cur" src="/series/${seriesId}/cover" alt="">` : '<span class="dim">no cover yet</span>'}
         <span class="hint">the one in use now</span>
         <a class="series" href="/series/${seriesId}" style="margin-left:auto">back to the series</a>
       </div>
       ${chapters.length === 0
         ? '<div class="bad" style="margin-top:10px">no readable chapter to take a page from</div>'
         : grid}
     </div>`);
}
