import { db } from "../db.js";
import { esc, page } from "./layout.js";

const CLIENT = String.raw`
const q = new URLSearchParams(location.search).get('q') || '';
const groups = new Map();
const el = document.getElementById('results');
const status = document.getElementById('status');
// Group on the work, not the release. Doujin titles carry the circle, the language and
// the release flags in brackets, so '[Circle] Title [Digital] [English] [MTL]' and
// '[Circle] Title [Korean] [x]' are one work listed four times. Alternative titles after
// a pipe are dropped for the same reason.
const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const workKey = s => norm(String(s).split('|')[0].replace(/[\[({][^\])}]*[\])}]/g,' '))
  .replace(/[^a-z0-9]/g,'');
// What distinguishes one listing from another within a work: exactly those bracketed
// tags, minus the circle name that every variant shares.
const variantOf = s => {
  const tags = (String(s).match(/\[[^\]]+\]/g) || []).slice(1)
    .filter(t => !/^\[digital\]$/i.test(t));
  return tags.join(' ');
};
const detailQueue = [];
let active = 0;

function render(g) {
  let card = document.getElementById('g-'+g.key);
  if (!card) {
    card = document.createElement('div');
    card.className = 'card srch';
    card.id = 'g-'+g.key;
    el.appendChild(card);
  }
  // Most chapters first, then prefer an English release over a translated one.
  const en = r => /english/i.test(r.variant||'') ? 0 : 1;
  const best = [...g.rows].sort((a,b)=>(b.chapters??-1)-(a.chapters??-1) || en(a)-en(b));
  const desc = g.description ? '<div class="desc">'+g.description+'</div>' : '';
  card.innerHTML =
    '<div class="srch-head">' +
      (g.thumb ? '<img class="cover" loading="lazy" src="'+g.thumb+'">' : '<div class="cover"></div>') +
      '<div class="srch-body"><div class="title">'+g.title+
        (g.have ? ' <a class="badge" href="/series/'+g.have+'">in library</a>' : '')+'</div>'+
        '<div class="meta">'+g.rows.length+' release'+(g.rows.length===1?'':'s')+
          (g.genres && g.genres.length ? ' &middot; '+g.genres.slice(0,5).join(', ') : '')+'</div>'+
        desc+
      '</div></div>' +
    '<table class="srcs"><tr><th>source</th><th>release</th><th>chapters</th><th>latest</th><th></th></tr>' +
    best.map(r => {
      const known = r.chapters !== undefined && r.chapters !== null;
      const empty = known && r.chapters === 0;   // one chapter is a real new series, zero is nothing
      const thin = known && r.chapters > 0 && r.chapters < 3;
      return '<tr>' +
        '<td>'+r.sourceName+(r.nsfw?' <span class="dim">18+</span>':'')+'</td>' +
        '<td class="dim">'+(r.variant || '-')+'</td>' +
        '<td class="'+(empty?'bad':thin?'warn':known?'rec':'dim')+'">'+(known ? r.chapters : '<span class="spin">checking</span>')+'</td>' +
        '<td class="dim">'+(r.lastUpload || '-')+'</td>' +
        '<td class="act">' + (empty
          ? '<span class="dim" title="this source lists the series but carries no chapters">empty</span>'
          : '<form method="post" action="/add">' +
            '<input type="hidden" name="title" value="'+r.title.replace(/"/g,'&quot;')+'">' +
            '<input type="hidden" name="sourceId" value="'+r.sourceId+'">' +
            '<input type="hidden" name="sourceName" value="'+r.sourceName.replace(/"/g,'&quot;')+'">' +
            '<input type="hidden" name="url" value="'+r.url.replace(/"/g,'&quot;')+'">' +
            '<button type="submit"'+(known?'':' disabled')+'>add</button></form>') +
        '</td></tr>';
    }).join('') + '</table>';
}

function pump() {
  while (active < 4 && detailQueue.length) {
    const { key, row } = detailQueue.shift();
    active++;
    fetch('/api/detail?mangaId='+row.mangaId).then(r=>r.json()).then(d => {
      row.chapters = d.chapters; row.lastUpload = d.lastUpload;
      const g = groups.get(key);
      if (g && !g.description && d.description) g.description = d.description.slice(0,300);
      if (g && (!g.genres || !g.genres.length) && d.genres) g.genres = d.genres;
      render(g);
    }).catch(()=>{ row.chapters = null; }).finally(()=>{ active--; pump(); });
  }
}

const es = new EventSource('/api/search?q='+encodeURIComponent(q));
let seen = 0;
es.addEventListener('hit', e => {
  const h = JSON.parse(e.data);
  const key = workKey(h.title);
  let g = groups.get(key);
  if (!g) { g = { key, title: h.title, thumb: h.thumb, rows: [], have: window.HAVE[norm(h.title)] }; groups.set(key, g); }
  if (!g.thumb && h.thumb) g.thumb = h.thumb;
  // The plainest title represents the work; the tagged ones are its releases.
  if (h.title.length < g.title.length) g.title = h.title;
  if (!g.have) g.have = window.HAVE[norm(h.title)];
  h.variant = variantOf(h.title);
  g.rows.push(h);
  seen++;
  render(g);
  detailQueue.push({ key, row: h });
  pump();
});
es.addEventListener('progress', e => {
  const p = JSON.parse(e.data);
  status.textContent = p.done+'/'+p.total+' sources searched, '+groups.size+' titles, '+seen+' results';
});
es.addEventListener('done', () => { es.close(); status.textContent += ' — done'; });
es.onerror = () => { es.close(); status.textContent += ' — connection ended'; };
`;

const EXTRA_CSS = `
.srch-head{display:flex;gap:16px;margin-bottom:12px;align-items:flex-start}
.cover{width:190px;height:272px;object-fit:cover;border-radius:4px;background:#242424;flex:0 0 auto}
.srch-body{min-width:0}
.desc{color:#999;font-size:12.5px;margin-top:7px;display:-webkit-box;-webkit-line-clamp:8;-webkit-box-orient:vertical;overflow:hidden}
table.srcs th:nth-child(2),table.srcs td:nth-child(2){max-width:220px}
table.srcs th:nth-child(3),table.srcs td:nth-child(3){width:88px}
table.srcs th:nth-child(4),table.srcs td:nth-child(4){width:110px}
table.srcs th:nth-child(5),table.srcs td:nth-child(5){width:96px;text-align:right}
td.act{text-align:right}
td.act form{display:inline}
.spin{color:#666;font-size:11px}
button[disabled]{opacity:.4;cursor:default}
`;

export async function searchPage(query?: string): Promise<string> {
  const have = Object.fromEntries((await db().query<{ id: number; title: string }>(
    "SELECT id, title FROM series")).rows.map((r) =>
      [r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(), r.id]));

  const form = `<div class="card">
    <form method="get" action="/search">
      <input type="search" name="q" placeholder="search every source" value="${esc(query ?? "")}" autofocus>
      <button type="submit">search</button>
      <span class="dim" id="status" style="margin-left:12px">${query ? "starting" : ""}</span>
    </form></div>`;

  if (!query) {
    return page("search", "global search", `<style>${EXTRA_CSS}</style>` + form +
      `<div class="card dim">Searches every installed English source at once and fills in results as they
       arrive. Chapter counts appear per source once checked, so a source carrying two chapters is obvious
       before you pick it.</div>`);
  }

  return page("search", "global search",
    `<style>${EXTRA_CSS}</style>${form}<div id="results"></div>
     <script>window.HAVE=${JSON.stringify(have)};</script>
     <script>${CLIENT}</script>`);
}
