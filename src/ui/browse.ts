import type { ServerResponse } from "node:http";
import { gql, installedSources } from "../suwayomi.js";
import { esc, page } from "./layout.js";

const FILTERS = `query($id:LongString!){ source(id:$id){
  id displayName lang isNsfw supportsLatest
  filters{
    __typename
    ... on TextFilter { name }
    ... on SelectFilter { name values }
    ... on CheckBoxFilter { name }
    ... on TriStateFilter { name }
    ... on SortFilter { name values }
    ... on GroupFilter { name filters{
        __typename
        ... on TriStateFilter { name }
        ... on CheckBoxFilter { name }
        ... on SelectFilter { name values } } }
  } } }`;

type Inner = { __typename: string; name?: string | null; values?: string[] | null };
type Filter = Inner & { filters?: Inner[] | null };
type Src = { id: string; displayName: string; lang: string; isNsfw: boolean; supportsLatest: boolean; filters: Filter[] };

const sourceFilters = async (id: string): Promise<Src> =>
  (await gql<{ source: Src }>(FILTERS, { id })).source;

/**
 * Filter selections travel in the url as "group.inner.state" triples, so a browse view
 * is a plain link that can be bookmarked and shared, with no session state.
 */
export function parseFilterParams(values: string[]): unknown[] {
  const out: unknown[] = [];
  for (const v of values) {
    const [a, b, c] = v.split(".");
    const pos = Number(a);
    if (!Number.isInteger(pos)) continue;
    if (b === undefined || b === "") continue;
    if (c === "sort") { out.push({ position: pos, sortState: { index: Number(b), ascending: false } }); continue; }
    if (c === "select") { out.push({ position: pos, selectState: Number(b) }); continue; }
    const inner = Number(b);
    if (!Number.isInteger(inner)) continue;
    // Genre and status groups are tri-state: include, exclude, ignore.
    out.push({ position: pos, groupChange: { position: inner, triState: c === "exclude" ? "EXCLUDE" : "INCLUDE" } });
  }
  return out;
}

export async function browseIndex(): Promise<string> {
  const sources = (await installedSources()).filter((s) => s.lang === "en" || s.lang === "all")
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const rows = sources.map((s) => `<tr>
    <td><a class="series" href="/browse/${encodeURIComponent(s.id)}">${esc(s.displayName)}</a></td>
    <td class="dim">${esc(s.lang)}${s.isNsfw ? ' <span class="dim">18+</span>' : ""}</td>
  </tr>`).join("");
  return page("browse", `${sources.length} sources`,
    `<div class="card"><div class="title">Browse a source</div>
       <div class="meta">Metadata catalogues do not carry everything, so browsing goes straight at the source.
         Each one exposes its own genre and status filters.</div>
       <table><tr><th>source</th><th>lang</th></tr>${rows}</table></div>
     <div class="card"><div class="title">Need a different site?</div>
       <div class="meta"><a class="series" href="/extensions">Install another extension</a> &mdash;
         1372 available, and only what you install is searched.</div></div>`);
}

const EXTRA = `
.grid2{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:14px}
.bt{border-radius:6px;overflow:hidden}
.bt img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;background:#222}
.bt .n{padding:8px 9px;font-size:13px;line-height:1.35;height:58px;overflow:hidden}
.bt .f{padding:0 8px 8px;display:flex;justify-content:space-between;align-items:center;font-size:11px}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}
.chip{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid rgba(0,0,0,.25);color:#4a4034;text-decoration:none}
.chip.on{background:#5d8a4a;color:#f2f6ee;border-color:#476b38;font-weight:700}
`;

export async function browseSource(sourceId: string, type: string, filters: string[]): Promise<string> {
  const src = await sourceFilters(sourceId);
  const active = new Set(filters);
  const qs = (extra: string[]): string => {
    const p = new URLSearchParams();
    p.set("type", type);
    for (const f of extra) p.append("f", f);
    return p.toString();
  };
  const toggle = (key: string): string => {
    const next = active.has(key) ? [...active].filter((k) => k !== key) : [...active, key];
    return `/browse/${encodeURIComponent(sourceId)}?${qs(next)}`;
  };

  // Only the filter shapes worth exposing: genre-style groups, selects and sort.
  const groups = src.filters.map((f, i) => ({ f, i }))
    .filter(({ f }) => f.__typename === "GroupFilter" && (f.filters?.length ?? 0) > 0);

  const chips = groups.map(({ f, i }) => {
    const items = (f.filters ?? []).map((inner, j) => {
      const key = `${i}.${j}.include`;
      return `<a class="chip ${active.has(key) ? "on" : ""}" href="${toggle(key)}">${esc(inner.name ?? "?")}</a>`;
    }).join("");
    return `<div style="margin-bottom:8px"><div class="dim" style="font-size:11px">${esc(f.name ?? "filter")}</div>
      <div class="chips">${items}</div></div>`;
  }).join("");

  const tab = (t: string, label: string): string =>
    `<a class="chip ${type === t ? "on" : ""}" href="/browse/${encodeURIComponent(sourceId)}?${(() => {
      const p = new URLSearchParams(); p.set("type", t);
      for (const f of active) p.append("f", f);
      return p.toString();
    })()}">${label}</a>`;

  return page("browse", esc(src.displayName),
    `<style>${EXTRA}</style>
     <div class="card">
       <div class="title">${esc(src.displayName)}</div>
       <div class="chips">${tab("POPULAR", "Popular")}${src.supportsLatest ? tab("LATEST", "Latest") : ""}
         ${active.size > 0 ? `<a class="chip" href="/browse/${encodeURIComponent(sourceId)}?type=${esc(type)}">clear filters</a>` : ""}</div>
       ${chips || '<div class="dim">this source exposes no filters</div>'}
     </div>
     <div class="card"><span class="dim" id="status">loading</span></div>
     <div class="grid2" id="results"></div>
     <script>
     const params = new URLSearchParams(location.search);
     const url = '/api/browse?source=' + encodeURIComponent(${JSON.stringify(sourceId)}) + '&' + params.toString();
     const el = document.getElementById('results'), status = document.getElementById('status');
     const q = []; let active = 0;
     function detail(id, card) {
       q.push([id, card]);
       (function pump(){
         while (active < 4 && q.length) {
           const [i, c] = q.shift(); active++;
           fetch('/api/detail?mangaId='+i).then(r=>r.json()).then(d=>{
             const n = c.querySelector('.ch');
             if (d.chapters === null || d.chapters === undefined) { n.textContent = '?'; return; }
             n.textContent = d.chapters + ' ch';
             n.className = 'ch ' + (d.chapters === 0 ? 'bad' : d.chapters < 3 ? 'warn' : 'rec');
             if (d.chapters === 0) { const b = c.querySelector('button'); if (b) { b.disabled = true; b.textContent = 'empty'; } }
           }).catch(()=>{}).finally(()=>{ active--; pump(); });
         }
       })();
     }
     document.addEventListener('submit', ev => {
       const f = ev.target;
       if (!f.classList || !f.classList.contains('addf')) return;
       ev.preventDefault();
       const b = f.querySelector('button');
       b.disabled = true; b.textContent = 'adding';
       fetch('/add', { method: 'POST', body: new URLSearchParams(new FormData(f)) })
         .then(r => {
           const id = (r.url.match(/\/series\/(\d+)/) || [])[1];
           f.outerHTML = id ? '<a class="series" href="/series/'+id+'">added &rarr;</a>' : '<span class="bad">failed</span>';
         })
         .catch(() => { b.disabled = false; b.textContent = 'retry'; });
     });

     const es = new EventSource(url);
     let n = 0;
     es.addEventListener('hit', e => {
       const h = JSON.parse(e.data); n++;
       const d = document.createElement('div');
       d.className = 'bt';
       d.innerHTML = (h.thumb ? '<img loading="lazy" src="'+h.thumb+'">' : '<img>') +
         '<div class="n">'+h.title.replace(/</g,'&lt;')+'</div>' +
         '<div class="f"><span class="ch dim">checking</span>' +
         '<form class="addf" method="post" action="/add"><input type="hidden" name="title" value="'+h.title.replace(/"/g,'&quot;')+'">' +
         '<input type="hidden" name="sourceId" value="'+h.sourceId+'">' +
         '<input type="hidden" name="sourceName" value="'+h.sourceName.replace(/"/g,'&quot;')+'">' +
         '<input type="hidden" name="url" value="'+h.url.replace(/"/g,'&quot;')+'">' +
         '<button type="submit">add</button></form></div>';
       el.appendChild(d);
       detail(h.mangaId, d);
       status.textContent = n + ' titles';
     });
     es.addEventListener('done', () => { es.close(); status.textContent = n + ' titles — done'; });
     es.onerror = () => { es.close(); };
     </script>`);
}

/** Streams one page of a source's popular or latest listing. */
export async function streamBrowse(res: ServerResponse, sourceId: string, type: string, filters: string[]): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const src = await sourceFilters(sourceId);
  const parsed = parseFilterParams(filters);
  // A filtered listing is a SEARCH with no text: POPULAR ignores filters entirely.
  const kind = parsed.length > 0 ? "SEARCH" : (type === "LATEST" ? "LATEST" : "POPULAR");
  try {
    const r = await gql<{ fetchSourceManga: { hasNextPage: boolean; mangas: Array<{ id: number; title: string; url: string; thumbnailUrl: string | null }> } }>(
      `mutation($s:LongString!,$t:FetchSourceMangaType!,$f:[FilterChangeInput!]){
         fetchSourceManga(input:{source:$s,type:$t,page:1,filters:$f}){ hasNextPage mangas{ id title url thumbnailUrl } } }`,
      { s: sourceId, t: kind, f: parsed });
    for (const m of r.fetchSourceManga.mangas) {
      send("hit", { sourceId, sourceName: src.displayName, mangaId: m.id, title: m.title, url: m.url, thumb: `/thumb/${m.id}` });
    }
  } catch (err) {
    send("error", { message: err instanceof Error ? err.message : String(err) });
  }
  send("done", {});
  res.end();
}
