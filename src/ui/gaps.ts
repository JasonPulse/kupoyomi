import { findGaps, findGapSources } from "../gaps.js";
import { esc, page } from "./layout.js";

/**
 * Shows which sources carry the specific chapters a series is missing, and lets one be
 * chosen. Taking chapters from a source means using that source, so choosing one here
 * switches the series to it. There is no second source to fill from.
 */
export async function gapsPage(seriesId: number): Promise<string> {
  const g = await findGaps(seriesId);
  if (g.missing.length === 0) {
    return page("library", `${esc(g.title)}: no gaps`,
      `<div class="card"><div class="title">${esc(g.title)}</div>
       <div class="meta">no missing chapters inside the held range</div>
       <div class="actions"><a class="series" href="/series/${seriesId}">back to the series</a></div></div>`);
  }

  const sources = await findGapSources(seriesId);
  const rows = sources.map((s) => `<tr>
      <td>${esc(s.sourceName)}</td>
      <td class="rec"><b>${s.covers.length}</b> of ${g.unsupplied.length}</td>
      <td class="dim" style="font-size:12px">${esc(s.covers.slice(0, 18).join(", "))}${s.covers.length > 18 ? " ..." : ""}</td>
      <td><form method="post" action="/series/${seriesId}/gaps">
        <input type="hidden" name="sourceId" value="${esc(s.sourceId)}">
        <input type="hidden" name="sourceName" value="${esc(s.sourceName)}">
        <input type="hidden" name="url" value="${esc(s.url)}">
        <input type="hidden" name="numbers" value="${esc(s.covers.join(","))}">
        <button type="submit">queue ${s.covers.length}</button></form></td>
    </tr>`).join("");

  return page("library", `${esc(g.title)}: ${g.missing.length} gaps`,
    `<div class="card">
       <div class="title">${esc(g.title)}</div>
       <div class="meta">${g.missing.length} chapters missing inside the held range
         &middot; ${g.queued.length} already queued from the current source
         &middot; <b>${g.unsupplied.length}</b> need another source</div>
       <div class="dim" style="font-size:12px;margin-top:6px">missing:
         ${esc(g.missing.slice(0, 60).join(", "))}${g.missing.length > 60 ? " ..." : ""}</div>
       <div class="actions"><a class="series" href="/series/${seriesId}">back to the series</a>
         <span class="hint">this switches the series to that source and queues the chapters it covers</span></div>
     </div>
     <div class="card"><h2>Sources carrying the missing chapters</h2>
       <table><tr><th>source</th><th>covers</th><th>chapters it has</th><th></th></tr>
       ${rows || `<tr><td colspan="4" class="dim">no installed source carries any of the missing chapters
         &mdash; they may not exist anywhere, which is common for delisted early chapters</td></tr>`}</table>
     </div>`);
}
