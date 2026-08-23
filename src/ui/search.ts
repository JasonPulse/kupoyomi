import { db } from "../db.js";
import { isPaidSource } from "../paid.js";
import { gql, installedSources } from "../suwayomi.js";
import { queryVariants } from "../match.js";
import { canonical } from "../seed.js";
import { esc, page } from "./layout.js";

const SEARCH = `mutation($src:LongString!,$q:String!){
  fetchSourceManga(input:{source:$src,type:SEARCH,query:$q,page:1}){ mangas{ id title url thumbnailUrl } } }`;

export type Hit = { sourceId: string; sourceName: string; mangaId: number; title: string; url: string };

/**
 * Global search across every installed English source.
 *
 * Fanned out with a concurrency cap rather than all at once: 54 sources means 54
 * requests per query, and the point of keeping the installed set small is that this
 * stays fast and stays polite.
 */
export async function searchAll(query: string, concurrency = 8): Promise<Hit[]> {
  const sources = (await installedSources()).filter((s) => s.lang === "en" || s.lang === "all");
  const out: Hit[] = [];
  const queue = [...sources];

  const worker = async (): Promise<void> => {
    for (;;) {
      const src = queue.shift();
      if (!src) return;
      try {
        const r = await gql<{ fetchSourceManga: { mangas: Array<{ id: number; title: string; url: string }> } }>(
          SEARCH, { src: src.id, q: query });
        for (const m of r.fetchSourceManga.mangas.slice(0, 6)) {
          out.push({ sourceId: src.id, sourceName: src.displayName, mangaId: m.id, title: m.title, url: m.url });
        }
      } catch { /* one dead source must not spoil the search */ }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

export async function searchPage(query?: string): Promise<string> {
  const sources = (await installedSources()).filter((s) => s.lang === "en" || s.lang === "all");
  const form = `<div class="card">
    <form method="get" action="/search">
      <input type="search" name="q" placeholder="search every source for a series" value="${esc(query ?? "")}" autofocus>
      <button type="submit">search</button>
      <span class="dim" style="margin-left:10px">${sources.length} sources</span>
    </form></div>`;

  if (!query) {
    return page("search", "global search",
      form + `<div class="card dim">Searches every installed English source at once. Results group by title;
        adding one creates the series and starts fetching what it has.</div>`);
  }

  const hits = await searchAll(query);
  // Group by title so one series with five sources is one decision, not five rows.
  const groups = new Map<string, Hit[]>();
  for (const h of hits) {
    const k = h.title.toLowerCase().trim();
    const l = groups.get(k);
    if (l) l.push(h); else groups.set(k, [h]);
  }

  // Anything already in the library is called out, so a second copy is never added by
  // accident -- duplicates are the problem this project exists to remove.
  const have = new Map((await db().query<{ id: number; title: string }>(
    "SELECT id, title FROM series")).rows.map((r) => [r.title.toLowerCase().trim(), r.id]));

  const cards = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([k, hs]) => {
      const first = hs[0]!;
      const existing = have.get(k);
      const rows = hs.map((h) => `<tr>
        <td>${esc(h.sourceName)}</td>
        <td class="dim" style="font-size:11px">${esc(h.url.slice(0, 60))}</td>
        <td><form method="post" action="/add">
          <input type="hidden" name="title" value="${esc(h.title)}">
          <input type="hidden" name="sourceId" value="${esc(h.sourceId)}">
          <input type="hidden" name="sourceName" value="${esc(h.sourceName)}">
          <input type="hidden" name="url" value="${esc(h.url)}">
          <button class="${existing ? "weak" : ""}" type="submit">${existing ? "add as another source" : "add"}</button>
        </form></td></tr>`).join("");
      return `<div class="card">
        <div class="title">${esc(first.title)}</div>
        <div class="meta">${hs.length} source${hs.length === 1 ? "" : "s"}${
          existing ? ` &middot; <a class="series" href="/series/${existing}">already in your library</a>` : ""}</div>
        <table><tr><th>source</th><th>url</th><th></th></tr>${rows}</table></div>`;
    }).join("");

  return page("search", `${groups.size} titles from ${hits.length} results`,
    form + (cards || '<div class="card dim">nothing found on any installed source</div>'));
}

/** Creates the series and its primary binding, then queues whatever the source has. */
export async function addSeries(v: { title: string; sourceId: string; sourceName: string; url: string }): Promise<number> {
  // The last gate. A paid source is filtered out of search and browse, but a stale page
  // or a hand-built request could still post one, and binding to it is the mistake worth
  // preventing: its chapters download as a purchase notice and the ledger then treats
  // them as held, so a real source's chapters are skipped as already present.
  if (await isPaidSource(v.sourceName)) {
    throw new Error(`${v.sourceName} is a paid subscription service and cannot be downloaded from`);
  }
  const p = db();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const s = await client.query<{ id: number }>(
      `INSERT INTO series (title, folder) VALUES ($1,$2)
       ON CONFLICT (folder) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
      [v.title, canonical(v.title)]);
    const id = s.rows[0]!.id;
    const existing = (await client.query<{ id: number }>(
      "SELECT id FROM series_binding WHERE series_id = $1 AND role = 'primary'", [id])).rows[0];
    await client.query(
      `INSERT INTO series_binding (series_id, source_id, source_name, source_manga_id, source_url, role)
       VALUES ($1,$2,$3,0,$4,$5)
       ON CONFLICT (series_id, source_id, source_manga_id)
         DO UPDATE SET source_url = EXCLUDED.source_url`,
      [id, v.sourceId, v.sourceName, v.url, existing ? "supplemental" : "primary"]);
    await client.query("COMMIT");
    return id;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
