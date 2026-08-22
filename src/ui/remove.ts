import { planRemoval } from "../remove.js";
import { esc, page } from "./layout.js";

const gb = (n: number): string => (n / 1073741824).toFixed(2);

/**
 * Deleting is irreversible, so it gets a page that states exactly what goes rather than
 * a button that quietly does it.
 */
export async function confirmRemovalPage(seriesId: number): Promise<string> {
  const p = await planRemoval(seriesId);
  const legacy = p.legacyDirs.map((d) => `<tr><td class="dim" style="font-size:12px">${esc(d.path)}</td>
      <td>${d.files} files</td></tr>`).join("");

  return page("library", `remove ${esc(p.title)}`,
    `<div class="card">
       <div class="title">Remove &ldquo;${esc(p.title)}&rdquo; from the library?</div>
       <div class="meta">${p.chapters} chapters in the ledger &middot; ${p.canonicalFiles} files on disk
         &middot; ${gb(p.bytes)}GB</div>
       <table>
         <tr><th>what</th><th>effect</th></tr>
         <tr><td>Database</td><td>the series, its ${p.chapters} chapter rows, its bindings,
           reading progress and anything queued &mdash; all removed</td></tr>
         <tr><td>Library files</td><td><span class="dim">${esc(p.canonicalDir)}</span></td></tr>
         ${p.sharedFiles > 0 ? `<tr><td>Disk space</td><td><span class="warn">${p.sharedFiles}
           of ${p.canonicalFiles} files are hardlinks with another copy in the old Suwayomi tree,
           so deleting the library copy alone frees nothing</span></td></tr>` : ""}
       </table>

       ${p.legacyDirs.length > 0 ? `<h2 style="margin-top:14px">Original copies in the old tree</h2>
         <table><tr><th>folder</th><th></th></tr>${legacy}</table>` : ""}

       <form method="post" action="/series/${p.seriesId}/remove" class="actions" style="flex-wrap:wrap">
         <label><input type="checkbox" name="files" value="1" checked> delete the library files</label>
         ${p.legacyDirs.length > 0
           ? `<label><input type="checkbox" name="legacy" value="1"> also delete the originals
                (${p.legacyDirs.reduce((a, d) => a + d.files, 0)} files) &mdash; this is what actually frees the space</label>`
           : ""}
         <button type="submit">remove permanently</button>
         <a class="series" href="/series/${p.seriesId}">cancel</a>
       </form>
       <div class="meta" style="margin-top:8px">Leaving both unchecked removes only the database
         entry and leaves every file where it is.</div>
     </div>`);
}
