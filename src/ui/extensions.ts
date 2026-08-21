import { db } from "../db.js";
import { gql, installedExtensions } from "../suwayomi.js";
import { esc, page } from "./layout.js";

type Ext = { pkgName: string; name: string; lang: string; isNsfw: boolean; isInstalled: boolean; isObsolete: boolean; hasUpdate: boolean; versionName: string };

const all = async (): Promise<Ext[]> =>
  (await gql<{ extensions: { nodes: Ext[] } }>(
    `{ extensions { nodes { pkgName name lang isNsfw isInstalled isObsolete hasUpdate versionName } } }`)).extensions.nodes;

/**
 * Installing a source is how you browse a site we do not have yet, so it belongs in the
 * UI rather than in a CLI. Every installed extension widens the fan-out of every search,
 * so the count of what is installed is shown next to the count of what exists.
 */
export async function extensionsPage(opts: { q?: string; lang?: string; nsfw?: boolean; installed?: boolean } = {}): Promise<string> {
  const list = await all();
  const declared = new Set((await db().query<{ pkg_name: string }>(
    "SELECT pkg_name FROM extension WHERE desired").catch(() => ({ rows: [] as Array<{ pkg_name: string }> }))).rows
    .map((r) => r.pkg_name));

  const installedCount = list.filter((e) => e.isInstalled).length;
  let shown = list.filter((e) => opts.lang ? e.lang === opts.lang : (e.lang === "en" || e.lang === "all"));
  if (opts.q) shown = shown.filter((e) => e.name.toLowerCase().includes(opts.q!.toLowerCase()));
  if (opts.nsfw === false) shown = shown.filter((e) => !e.isNsfw);
  if (opts.installed) shown = shown.filter((e) => e.isInstalled);
  shown.sort((a, b) => Number(b.isInstalled) - Number(a.isInstalled) || a.name.localeCompare(b.name));

  const rows = shown.slice(0, 400).map((e) => `<tr>
    <td>${esc(e.name)}${e.isNsfw ? ' <span class="dim">18+</span>' : ""}${
      e.isObsolete ? ' <span class="bad">removed upstream</span>' : ""}</td>
    <td class="dim">${esc(e.lang)}</td>
    <td class="dim">${esc(e.versionName)}${e.hasUpdate ? ' <span class="warn">update</span>' : ""}</td>
    <td>${e.isInstalled
      ? (declared.has(e.pkgName) ? '<span class="rec">installed</span>' : '<span class="warn">installed, not declared</span>')
      : '<span class="dim">-</span>'}</td>
    <td class="act"><form method="post" action="/extensions/${e.isInstalled ? "uninstall" : "install"}">
      <input type="hidden" name="pkg" value="${esc(e.pkgName)}">
      <button class="${e.isInstalled ? "weak" : ""}" type="submit">${e.isInstalled ? "remove" : "install"}</button>
    </form></td></tr>`).join("");

  return page("extensions",
    `${installedCount} installed of ${list.length} available`,
    `<style>td.act{text-align:right}td.act form{display:inline}
       th:nth-child(5),td:nth-child(5){width:96px}</style>
     <div class="card">
       <form method="get" action="/extensions">
         <input type="search" name="q" placeholder="filter by name" value="${esc(opts.q ?? "")}">
         <button type="submit">filter</button>
         <a class="dim" style="margin-left:10px" href="/extensions?installed=1">installed only</a>
         <a class="dim" style="margin-left:10px" href="/extensions?nsfw=0">hide 18+</a>
         <a class="dim" style="margin-left:10px" href="/extensions">all English</a>
       </form>
       <div class="meta" style="margin-top:8px">Installing a source lets you browse and search it.
         Every installed source is queried on every global search, so a smaller set stays faster.</div>
     </div>
     <div class="card"><table>
       <tr><th>extension</th><th>lang</th><th>version</th><th>state</th><th></th></tr>
       ${rows || '<tr><td colspan="5" class="dim">nothing matches</td></tr>'}
     </table>${shown.length > 400 ? `<div class="dim" style="margin-top:8px">showing 400 of ${shown.length}</div>` : ""}</div>`);
}

/** Installed extensions are recorded as declared, so a cold Suwayomi gets them back. */
export async function setExtension(pkg: string, install: boolean): Promise<void> {
  await gql(`mutation($pkg:String!){ updateExtension(input:{id:$pkg,patch:{${install ? "install" : "uninstall"}:true}}){ clientMutationId } }`,
    { pkg });
  if (install) {
    await db().query(
      `INSERT INTO extension (pkg_name, desired) VALUES ($1,true)
       ON CONFLICT (pkg_name) DO UPDATE SET desired = true`, [pkg]);
  } else {
    await db().query("UPDATE extension SET desired = false WHERE pkg_name = $1", [pkg]);
  }
}
