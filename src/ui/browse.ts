import type { ServerResponse } from "node:http";
import { gql } from "../suwayomi.js";
import { usableSources } from "../paid.js";
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
  const sources = await usableSources();
  // supportsLatest false has tracked exactly with an empty popular listing on this
  // library, so it is worth warning about rather than letting the page come up blank.
  const rows = [...sources].sort((a, b) => Number(b.supportsLatest) - Number(a.supportsLatest)
      || a.displayName.localeCompare(b.displayName)).map((s) => `<tr>
    <td><a class="series" href="/browse/${encodeURIComponent(s.id)}">${esc(s.displayName)}</a></td>
    <td class="dim">${esc(s.lang)}${s.isNsfw ? " &middot; 18+" : ""}</td>
    <td class="dim">${s.supportsLatest ? "popular + latest" : '<span class="warn">may not list anything</span>'}</td>
  </tr>`).join("");
  return page("browse", `${sources.length} sources`,
    `<div class="card"><div class="title">Browse a source</div>
       <div class="meta">Metadata catalogues do not carry everything, so browsing goes straight at the source.
         Each one exposes its own genre and status filters.</div>
       <table><tr><th>source</th><th>lang</th><th>listings</th></tr>${rows}</table></div>
     <div class="card"><div class="title">Need a different site?</div>
       <div class="meta"><a class="series" href="/extensions">Install another extension</a> &mdash;
         1372 available, and only what you install is searched.</div></div>`);
}

const EXTRA = `
.grid2{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:14px}
.bt{border-radius:6px;overflow:hidden}
.bt img{width:100%;aspect-ratio:2/3;object-fit:cover;display:block;background:#1a1715}
.bt{display:flex;flex-direction:column}
.bt .n{padding:8px 9px 3px;font-size:13px;line-height:1.35;max-height:56px;overflow:hidden;font-weight:600}
.bt .syn{padding:0 9px;font-size:11.5px;line-height:1.4;color:#c6c6cf;
  display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.bt .syn.none{color:#7a7a85;font-style:italic}
.bt .when{padding:4px 9px 0;font-size:11px}
.bt .f{padding:6px 8px 8px;display:flex;justify-content:space-between;align-items:center;
  font-size:11px;gap:6px;margin-top:auto}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin:8px 0}
.chip{font-size:11px;padding:3px 9px;border-radius:2px;border:1px solid rgba(227,182,97,.28);color:var(--ink-dim);text-decoration:none;background:rgba(255,255,255,.04)}
.chip:hover{border-color:rgba(227,182,97,.55);color:#f3ece1;background:rgba(255,239,221,.08)}
.chip.on{background:#5d8a4a;color:#f2f6ee;border-color:#476b38;font-weight:700}
`;

const CLIENT = String.raw`
const params = new URLSearchParams(location.search);
const url = '/api/browse?source=' + encodeURIComponent(document.body.dataset.source) + '&' + params.toString();
const el = document.getElementById('results'), status = document.getElementById('status');
const q = []; let active = 0;
function detail(id, card) {
  q.push([id, card]);
  (function pump(){
    while (active < 4 && q.length) {
      const [i, c] = q.shift(); active++;
      fetch('/api/detail?mangaId='+i).then(r=>r.json()).then(d=>{
        const n = c.querySelector('.ch');
        // The detail call already carried a synopsis, a status and an upload date. Only
        // the chapter count was ever shown, so a browse tile said far less than a search
        // card about the same title.
        const syn = c.querySelector('.syn');
        if (syn) {
          if (d.description) { syn.textContent = d.description; syn.className = 'syn'; }
          else { syn.textContent = 'no synopsis from this source'; syn.className = 'syn none'; }
        }
        const w = c.querySelector('.when');
        if (w) {
          const bits = [];
          if (d.status && d.status !== 'UNKNOWN') bits.push(d.status.toLowerCase());
          if (d.lastUpload) bits.push(d.lastUpload);
          w.textContent = bits.join(' \u00b7 ');
        }
        if (d.chapters === null || d.chapters === undefined) { n.textContent = '?'; return; }
        // Unique chapters, and say so when the source has each one several times over.
        n.textContent = d.chapters + ' ch' + (d.total > d.chapters * 1.15 ? ' of ' + d.total : '');
        if (d.total > d.chapters * 1.15) n.title = d.total + ' uploads for ' + d.chapters + ' chapters';
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
      const id = (r.url.split('/series/')[1] || '').split(/[^0-9]/)[0];
      f.outerHTML = id ? '<a class="series" href="/series/'+id+'">added &rarr;</a>' : '<span class="bad">failed</span>';
    })
    .catch(() => { b.disabled = false; b.textContent = 'retry'; });
});

const es = new EventSource(url);
let n = 0, finished = false;
status.textContent = 'contacting the source';
es.addEventListener('start', e => {
  const d = JSON.parse(e.data);
  status.textContent = 'reading ' + d.source + ' (' + d.kind.toLowerCase() + ')';
});
es.addEventListener('page', e => {
  const d = JSON.parse(e.data);
  status.textContent = n + ' titles from ' + d.page + ' page' + (d.page===1?'':'s') + (d.more ? ', more available' : '');
});
es.addEventListener('failed', e => {
  const d = JSON.parse(e.data);
  status.innerHTML = '<span class="bad">this source returned an error: ' + d.message.slice(0,140) + '</span>';
});
es.addEventListener('hit', e => {
  const h = JSON.parse(e.data); n++;
  const d = document.createElement('div');
  d.className = 'bt';
  d.innerHTML = (h.thumb ? '<img loading="lazy" src="'+h.thumb+'">' : '<img>') +
    '<div class="n">'+h.title.replace(/</g,'&lt;')+'</div>' +
    '<div class="syn none">loading</div>' +
    '<div class="when dim"></div>' +
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
es.addEventListener('done', () => {
  finished = true; es.close();
  if (n === 0 && !status.innerHTML.includes('error')) {
    status.innerHTML = '<span class="warn">this source has no browsable listing</span> — ' +
      'some sources only answer searches. <a href="/search">Search instead</a>, or pick another source.';
  } else if (n > 0) { status.textContent = n + ' titles'; }
});
// A silent onerror was why the page sat on 'loading' whenever anything went wrong.
es.onerror = () => {
  es.close();
  if (!finished) status.innerHTML = '<span class="bad">lost the connection to the server</span>';
};
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
     <script>document.body.dataset.source=${JSON.stringify(sourceId)};</script>
     <div class="card">
       <div class="title">${esc(src.displayName)}</div>
       <div class="chips">${tab("POPULAR", "Popular")}${src.supportsLatest ? tab("LATEST", "Latest") : ""}
         ${active.size > 0 ? `<a class="chip" href="/browse/${encodeURIComponent(sourceId)}?type=${esc(type)}">clear filters</a>` : ""}</div>
       ${chips || '<div class="dim">this source exposes no filters</div>'}
     </div>
     <div class="card">
       <div class="dim" id="status" style="margin-bottom:12px">loading</div>
       <div class="grid2" id="results"></div>
     </div>
     <script>${CLIENT}</script>`);
}

/**
 * Streams a source's listing page by page.
 *
 * One request returns one page, so fetching several in sequence is what makes results
 * keep arriving rather than landing in a single lump. Every terminal state is reported:
 * a source that returns nothing (BaoBua does for POPULAR) used to leave the page saying
 * "loading" forever.
 */
export async function streamBrowse(
  res: ServerResponse, sourceId: string, type: string, filters: string[], maxPages = 3,
): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  let name = sourceId;
  try {
    const src = await sourceFilters(sourceId);
    name = src.displayName;
    const parsed = parseFilterParams(filters);
    // A filtered listing is a SEARCH with no text: POPULAR ignores filters entirely.
    const kind = parsed.length > 0 ? "SEARCH" : (type === "LATEST" ? "LATEST" : "POPULAR");
    send("start", { source: name, kind });

    let total = 0;
    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const r = await gql<{ fetchSourceManga: { hasNextPage: boolean; mangas: Array<{ id: number; title: string; url: string; thumbnailUrl: string | null }> } }>(
        `mutation($s:LongString!,$t:FetchSourceMangaType!,$p:Int!,$f:[FilterChangeInput!]){
           fetchSourceManga(input:{source:$s,type:$t,page:$p,filters:$f}){ hasNextPage mangas{ id title url thumbnailUrl } } }`,
        { s: sourceId, t: kind, p: pageNo, f: parsed });
      for (const m of r.fetchSourceManga.mangas) {
        send("hit", { sourceId, sourceName: name, mangaId: m.id, title: m.title, url: m.url, thumb: `/thumb/${m.id}` });
        total++;
      }
      send("page", { page: pageNo, total, more: r.fetchSourceManga.hasNextPage });
      if (!r.fetchSourceManga.hasNextPage) break;
    }
    send("done", { total, source: name, kind });
  } catch (err) {
    send("failed", { message: err instanceof Error ? err.message : String(err), source: name });
    send("done", { total: 0 });
  }
  res.end();
}
