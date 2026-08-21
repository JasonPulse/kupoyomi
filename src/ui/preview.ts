import { db } from "../db.js";
import { gql } from "../suwayomi.js";
import { resolveManga } from "../match.js";
import { esc, page } from "./layout.js";
import { fmt } from "../held.js";

/**
 * Looks at a series on a source without adding it.
 *
 * Adding used to be the only way to see what a source actually carries, which is a poor
 * trade when the answer might be "three chapters". This shows the cover, the synopsis and
 * the whole chapter list first, and adds only if you say so.
 */
export async function previewPage(sourceId: string, url: string, title: string): Promise<string> {
  let mangaId: number;
  try {
    mangaId = await resolveManga(sourceId, title, url);
  } catch (err) {
    return page("search", "preview",
      `<div class="card"><div class="title">${esc(title)}</div>
       <div class="meta bad">this source no longer returns that entry:
         ${esc(err instanceof Error ? err.message : String(err))}</div></div>`);
  }

  await gql(`mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchChapters:true,fetchManga:true}){ clientMutationId } }`,
    { id: mangaId }).catch(() => undefined);
  const d = (await gql<{ manga: { title: string; description: string | null; status: string; genre: string[];
      source: { displayName: string } | null;
      chapters: { totalCount: number; nodes: Array<{ chapterNumber: number | null; name: string | null; scanlator: string | null; uploadDate: string | null }> } } }>(
    `{ manga(id:${mangaId}) { title description status genre source{displayName}
         chapters { totalCount nodes { chapterNumber name scanlator uploadDate } } } }`)).manga;

  const nums = d.chapters.nodes.map((c) => c.chapterNumber).filter((n): n is number => n !== null);
  const whole = new Set(nums.filter(Number.isInteger));
  const gaps: number[] = [];
  if (whole.size > 0) for (let i = Math.min(...whole); i <= Math.max(...whole); i++) if (!whole.has(i)) gaps.push(i);

  // Already in the library? Then this is a candidate extra source, not a new series.
  const existing = (await db().query<{ id: number; title: string }>(
    "SELECT id, title FROM series WHERE lower(title) = lower($1)", [d.title])).rows[0];

  const rows = d.chapters.nodes.slice(0, 300).map((c) => `<tr>
    <td>ch ${c.chapterNumber === null ? "?" : fmt(c.chapterNumber)}</td>
    <td>${esc((c.name ?? "").slice(0, 70))}</td>
    <td class="dim">${esc(c.scanlator ?? "-")}</td>
    <td class="dim">${c.uploadDate ? new Date(Number(c.uploadDate)).toISOString().slice(0, 10) : "-"}</td>
  </tr>`).join("");

  const addForm = `<form method="post" action="/add">
      <input type="hidden" name="title" value="${esc(d.title)}">
      <input type="hidden" name="sourceId" value="${esc(sourceId)}">
      <input type="hidden" name="sourceName" value="${esc(d.source?.displayName ?? sourceId)}">
      <input type="hidden" name="url" value="${esc(url)}">
      <button type="submit">${existing ? "add as another source" : "add to library"}</button>
    </form>`;

  return page("search", `${d.chapters.totalCount} chapters on ${esc(d.source?.displayName ?? "this source")}`,
    `<style>.hero{display:flex;gap:18px;align-items:flex-start}
       .hero img{width:200px;height:286px;object-fit:cover;border-radius:5px;background:#2a2a30;flex:0 0 auto}
       .hero .syn{color:#4a4034;font-size:13px;margin-top:9px;white-space:pre-wrap}</style>
     <div class="card">
       <div class="hero">
         <img src="/thumb/${mangaId}" alt="">
         <div style="min-width:0">
           <div class="title">${esc(d.title)}</div>
           <div class="meta">${esc(d.source?.displayName ?? "")} &middot; ${d.chapters.totalCount} chapters
             ${nums.length ? `&middot; ${fmt(Math.min(...nums))}&ndash;${fmt(Math.max(...nums))}` : ""}
             ${gaps.length ? `&middot; <span class="warn">${gaps.length} gaps</span>` : "&middot; no gaps"}
             ${d.status && d.status !== "UNKNOWN" ? `&middot; ${esc(d.status.toLowerCase())}` : ""}</div>
           ${d.genre?.length ? `<div class="meta">${esc(d.genre.slice(0, 8).join(", "))}</div>` : ""}
           <div class="syn">${esc((d.description ?? "no synopsis").slice(0, 1200))}</div>
           <div class="actions">${addForm}
             ${existing ? `<a class="series" href="/series/${existing.id}">already in your library</a>`
                        : '<span class="hint">nothing is downloaded until you add it</span>'}</div>
         </div>
       </div>
     </div>
     <div class="card"><h2>Chapters on this source</h2>
       <table><tr><th>chapter</th><th>title</th><th>group</th><th>uploaded</th></tr>${
         rows || '<tr><td colspan="4" class="dim">this source lists no chapters</td></tr>'}</table>
       ${d.chapters.totalCount > 300 ? `<div class="dim" style="margin-top:8px">showing 300 of ${d.chapters.totalCount}</div>` : ""}
     </div>`);
}
