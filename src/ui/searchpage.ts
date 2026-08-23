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
const workKey = s => {
  const base = String(s).split('|')[0];
  const runs = (base.match(/[\[(][^\])]+[\])]/g) || [])
    .map(t => t.slice(1, -1).trim()).filter(t => RUN_TAG.test(t));
  return norm(base.replace(/[\[({][^\])}]*[\])}]/g,' ')).replace(/[^a-z0-9]/g,'')
    + (runs.length ? norm(runs.join('')).replace(/[^a-z0-9]/g,'') : '');
};
// What distinguishes one listing from another within a work: exactly those bracketed
// tags, minus the circle name that every variant shares.
const variantOf = s => {
  // Every tag, and parentheses as well as brackets. It used to slice off the first tag,
  // so "Kill the Villainess [Official]" and "Kill The Villainess [S3]" both reported no
  // release at all and looked like duplicate rows of one thing.
  const tags = (String(s).match(/[\[(][^\])]+[\])]/g) || [])
    .map(t => t.slice(1, -1).trim())
    .filter(t => t && !/^digital$/i.test(t));
  return tags.join(' \u00b7 ');
};
// A season or part marker is a different run of chapters, not a different edition of the
// same one, so it stays in the grouping key. Everything else in brackets is a language,
// a scanlator or an edition label and is stripped.
const RUN_TAG = /^(?:s|season|part|pt|vol|volume|book|arc)\s*\.?\s*\d+$|^\d+(?:st|nd|rd|th)\s+(?:season|part)$/i;
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
  const sorted = [...g.rows].sort((a,b)=>(b.chapters??-1)-(a.chapters??-1) || en(a)-en(b));
  // A site listing the same series twice under the same name is a duplicate row, not a
  // choice. MangaToday returned two entries, both 125 chapters and both 2024-01-02, and
  // the only difference was that one named a scanlator. Rows that agree on source,
  // count and date collapse into one, keeping whichever names a release, and only once
  // both counts are known so an unanswered row is never folded away.
  const best = [];
  for (const r of sorted) {
    const dup = best.find(o => o.sourceName === r.sourceName
      && typeof o.chapters === 'number' && typeof r.chapters === 'number'
      && o.chapters === r.chapters && (o.lastUpload || '') === (r.lastUpload || ''));
    if (!dup) { best.push(r); continue; }
    if (!dup.variant && r.variant) best[best.indexOf(dup)] = r;
  }
  // What is left can still repeat a source with a different count, which is a genuinely
  // different entry on that site. The url is the only thing that tells them apart.
  const repeated = new Set(best.map(r => r.sourceName).filter((n,i,a) => a.indexOf(n) !== i));
  // The median of what the group's sources report. ComicK listed 319 for a series every
  // other source put at 128, because it counts every language at once. Silently mixing
  // that in with the rest invites picking it as the fullest source.
  const counts = g.rows.map(r => r.chapters).filter(n => typeof n === 'number' && n > 0).sort((a,b)=>a-b);
  const median = counts.length >= 3 ? counts[Math.floor(counts.length/2)] : 0;
  const desc = g.description
    ? '<details class="dwrap"><summary class="desc">'+g.description+'</summary><div class="descfull">'+g.description+'</div></details>'
    : '';
  card.innerHTML =
    '<div class="srch-head">' +
      (g.thumb ? '<img class="cover" loading="lazy" src="'+g.thumb+'">' : '<div class="cover"></div>') +
      '<div class="srch-body"><div class="title">'+g.title+
        (g.have ? ' <a class="badge" href="/series/'+g.have+'">in library</a>' : '')+'</div>'+
        (g.have && g.held ? '<div class="meta">you hold <b>'+g.held+'</b> chapters'+
          (g.heldMax ? ', up to ch '+g.heldMax : '')+'</div>' : '')+
        '<div class="meta">'+best.length+' unique release'+(best.length===1?'':'s')+
          (g.rows.length !== best.length ? ' <span class="dim">('+g.rows.length+' listed in total)</span>' : '')+
          (g.genres && g.genres.length ? ' &middot; '+g.genres.slice(0,5).join(', ') : '')+'</div>'+
        desc+
      '</div></div>' +
    '<table class="srcs"><tr><th>source</th><th>release</th><th>chapters</th>' +
      (g.have ? '<th title="chapters past your highest -- the reason to switch">new</th>'
              + '<th title="chapters inside your range that you do not have">fills</th>'
              + '<th title="chapters you hold that this source does not carry. Costs nothing: the files stay">not carried</th>' : '') +
      '<th>latest</th><th></th></tr>' +
    best.map(r => {
      const known = r.chapters !== undefined && r.chapters !== null;
      const empty = known && r.chapters === 0;   // one chapter is a real new series, zero is nothing
      const thin = known && r.chapters > 0 && r.chapters < 3;
      const odd = median > 0 && known && r.chapters > 0
        && (r.chapters > median * 1.6 || r.chapters < median * 0.5);
      // A source uploading each chapter several times over reports far more rows than it
      // has chapters. ComicK listed 319 for a series that stops at 93.
      const padded = known && r.total > r.chapters * 1.15;
      return '<tr>' +
        '<td>'+r.sourceName+(r.nsfw?' <span class="dim">18+</span>':'')+
          (repeated.has(r.sourceName) && r.url
            ? '<div class="dim" style="font-size:10.5px">'+String(r.url).slice(-40).replace(/</g,'&lt;')+'</div>'
            : '')+'</td>' +
        '<td class="dim">'+(r.variant || '-')+'</td>' +
        '<td class="'+(empty?'bad':thin||odd?'warn':known?'rec':'dim')+'">'+
          (known ? r.chapters : '<span class="spin">checking</span>')+
          (known && r.highest ? '<div class="dim" style="font-size:10.5px">up to ch '+r.highest+'</div>' : '')+
          (padded ? '<div class="warn" style="font-size:10.5px">'+r.total+' uploads, so most chapters are here more than once</div>' : '')+
          (odd && !padded ? '<div class="warn" style="font-size:10.5px">most sources say about '+median+'</div>' : '')+
          '</td>' +
        (g.have ? (function(){
          const nb = r.newBeyond, fg = r.fillsGaps, nc = r.notCarried;
          const cell = (v, cls) => '<td class="'+(v > 0 ? cls : 'dim')+'">'+
            (v === undefined ? '<span class="dim">-</span>' : v > 0 ? '+'+v : '0')+'</td>';
          return cell(nb, 'rec') + cell(fg, 'rec') +
            '<td class="dim">'+(nc === undefined ? '-' : nc > 0 ? nc : '-')+'</td>';
        })() : '') +
        '<td class="dim">'+(r.lastUpload || '-')+'</td>' +
        '<td class="act"><a href="/preview?source='+
          encodeURIComponent(r.sourceId)+'&url='+encodeURIComponent(r.url)+'&title='+encodeURIComponent(r.title)+
          '" style="text-decoration:none"><button type="button" class="weak">details</button></a>' + (empty
          ? '<span class="dim" title="this source lists the series but carries no chapters">empty</span>'
          : '<form class="addf" method="post" action="/add">' +
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
    // When the work is already in the library, ask for the comparison too: what this
    // source offers past what is held, what holes it fills, what it does not carry.
    // That is what choosing a source actually needs, and it is why the migration page
    // existed at all.
    const g0 = groups.get(key);
    const url = '/api/detail?mangaId='+row.mangaId + (g0 && g0.have ? '&seriesId='+g0.have : '');
    fetch(url).then(r=>r.json()).then(d => {
      row.chapters = d.chapters; row.lastUpload = d.lastUpload;
      row.total = d.total; row.highest = d.highest;
      row.newBeyond = d.newBeyond; row.fillsGaps = d.fillsGaps; row.notCarried = d.notCarried;
      const g = groups.get(key);
      if (g && !g.description && d.description) g.description = d.description;
      if (g && (!g.genres || !g.genres.length) && d.genres) g.genres = d.genres;
      if (g && d.held !== undefined) { g.held = d.held; g.heldMax = d.heldMax; }
      render(g);
    }).catch(()=>{ row.chapters = null; }).finally(()=>{ active--; pump(); });
  }
}

// Adding must not navigate: batch-adding several results from one search is the point.
document.addEventListener('submit', ev => {
  const f = ev.target;
  if (!f.classList || !f.classList.contains('addf')) return;
  ev.preventDefault();
  const b = f.querySelector('button');
  b.disabled = true; b.textContent = 'adding';
  fetch('/add', { method: 'POST', body: new URLSearchParams(new FormData(f)) })
    .then(r => {
      const id = (r.url.split('/series/')[1] || '').split(/[^0-9]/)[0];
      f.outerHTML = id
        ? '<span class="rec">added</span> <a class="series" href="/series/'+id+'">open</a>'
        : '<span class="bad">failed</span>';
    })
    .catch(() => { b.disabled = false; b.textContent = 'retry'; });
});

// One site listed the same work as 'TS Villainess RTA' and 'TS Villianess RTA'. A
// transposed letter is a typo, not a different series, so keys within a couple of edits
// of an existing one are folded in. Only for long keys: on a short key two edits is a
// different word entirely.
function edits(a, b, cap) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j-1] + 1, prev[j-1] + (a[i-1] === b[j-1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}
function mergeKey(k) {
  if (k.length < 14) return k;
  for (const existing of groups.keys()) {
    if (existing.length < 14) continue;
    if (edits(k, existing, 2) <= 2) return existing;
  }
  return k;
}

const es = new EventSource('/api/search?q='+encodeURIComponent(q));
let seen = 0;
es.addEventListener('hit', e => {
  const h = JSON.parse(e.data);
  const key = mergeKey(workKey(h.title));
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
.desc{color:#4a4034;font-size:12.5px;margin-top:7px;display:-webkit-box;-webkit-line-clamp:10;-webkit-box-orient:vertical;overflow:hidden;cursor:pointer;list-style:none}
.desc::-webkit-details-marker{display:none}
.dwrap[open] .desc{display:none}
.descfull{color:#4a4034;font-size:12.5px;margin-top:7px;white-space:pre-wrap}
table.srcs th:nth-child(2),table.srcs td:nth-child(2){max-width:220px}
table.srcs th:nth-child(3),table.srcs td:nth-child(3){width:88px}
table.srcs th:nth-child(4),table.srcs td:nth-child(4){width:110px}
table.srcs th:nth-child(5),table.srcs td:nth-child(5){width:96px;text-align:right}
/* Side by side, not stacked. Stacked, the details link sat directly above the add
   button and on a phone the two were a thumb-width apart. */
td.act{text-align:right;white-space:nowrap}
td.act > *{display:inline-block;vertical-align:middle}
td.act form{display:inline-block;margin-left:6px}
.spin{color:#7a6d58;font-size:11px}
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
