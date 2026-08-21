export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
*{box-sizing:border-box}
body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#141414;color:#ddd}
header{padding:9px 20px 0;background:#1b1b1b;border-bottom:1px solid #3a3428;position:sticky;top:0;z-index:5;
  display:flex;gap:18px;align-items:flex-end;flex-wrap:wrap}
header h1{font-size:15px;margin:0 4px 5px 0;font-weight:600;color:#eee;display:flex;align-items:center;gap:8px}
header h1 img{border-radius:50%;display:block}
nav{display:flex;gap:6px;align-items:flex-end}
nav a{display:inline-block;height:28px;line-height:28px;padding:0 10px;font-size:12.5px;
  text-decoration:none;color:#9a9aa2;border-radius:3px 3px 0 0}
nav a:hover{color:#dfe3ea;background:#252525}
nav a.on{color:#2b2318;font-weight:700;padding:0 6px 0 4px;background:none;
  border-style:solid;border-width:0 20px 0 32px;
  border-image:url(/tab-on.png) 0 20 0 32 fill stretch}
.sub{color:#888;font-size:12px;margin-left:auto;padding-bottom:6px}
main{padding:18px 20px 40px;max-width:1240px;margin:0 auto}

/* Every panel is an FFXI news window: caps top and bottom as pseudo-elements so no
   markup changes, with the middle tiling vertically. One visual language throughout,
   rather than parchment on some pages and dark cards on others. */
.card,.tile{position:relative;background:url(/newsmiddle.png) repeat-y center top;background-size:100% auto;
  color:#2a241c;margin:0 0 16px}
/* Caps live inside the box. Hung outside they overlapped whatever came next and got
   clipped, which is why bottoms went missing. */
.card::before,.tile::before,.card::after,.tile::after{content:"";position:absolute;left:0;right:0;height:27px;
  background:url(/newstop.png) no-repeat center top;background-size:100% 100%;pointer-events:none}
.card::before,.tile::before{top:0}
.card::after,.tile::after{bottom:0;background-image:url(/newsbottom.png)}
/* Padding clears the caps so content never sits under the ornament. */
.card{padding:34px 30px}
.tile{padding:30px 22px;margin-bottom:0}

/* Dark ink on parchment, since the panels are now light. */
.title{font-weight:700;margin-bottom:2px;color:#2b2318}
.meta,.dim,.n{color:#6b5f4c;font-size:12px}
.card h2{font-size:14px;margin:0 0 9px;font-weight:700;color:#3a3025}
.card a,.tile a{color:#4a3a7a}
.rec{color:#2f6b3a}.bad{color:#9b3226}.warn{color:#8a5a12}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;color:#6b5f4c;font-weight:600;padding:5px 8px;border-bottom:1px solid rgba(0,0,0,.22);white-space:nowrap}
td{padding:5px 8px;border-bottom:1px solid rgba(0,0,0,.09);vertical-align:top}
tr:hover td{background:rgba(0,0,0,.05)}
.badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:9px;
  background:rgba(0,0,0,.10);color:#5a4d3a;border:1px solid rgba(0,0,0,.18)}
.actions{margin-top:10px;padding-top:9px;border-top:1px solid rgba(0,0,0,.14);display:flex;gap:8px;align-items:center}
.actions .hint{color:#6b5f4c;font-size:11px}
button{background:#5d8a4a;border:1px solid #476b38;color:#f2f6ee;font-weight:600;
  padding:4px 10px;border-radius:4px;cursor:pointer;font-size:13px}
button.weak{background:#cdc3ab;border-color:#a99d84;color:#3a3025}
button:hover{filter:brightness(1.08)}
button[disabled]{opacity:.45;cursor:default}
input[type=search],input[type=text]{background:#fdfaf1;border:1px solid #a99d84;color:#2b2318;
  padding:6px 10px;border-radius:4px;font-size:13px;min-width:320px}
a.series{color:#4a3a7a;text-decoration:none}a.series:hover{text-decoration:underline}
.bar{height:5px;background:rgba(0,0,0,.16);border-radius:3px;overflow:hidden;min-width:70px}
.bar > i{display:block;height:100%;background:#6b4fa0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.grid{align-items:stretch}
.grid .tile{display:flex;flex-direction:column;justify-content:center}

/* Cover art stays dark inside the parchment, so it reads as art laid on paper. */
.lc,.bt{background:#1d1d22;border:1px solid #3a3a44;box-shadow:0 1px 5px rgba(0,0,0,.35)}
.lc .t,.bt .n{color:#dde}
.lc .s{color:#9a9aa5}
.cover{background:#2a2a30}
`;

export type Nav = "library" | "browse" | "search" | "review" | "queue" | "downloads" | "extensions";

/** A parchment panel, for the primary content of a page. */
export const news = (title: string, inner: string): string =>
  `<div class="card">${title ? `<h2>${title}</h2>` : ""}${inner}</div>`;

export function page(active: Nav, subtitle: string, body: string): string {
  const link = (id: Nav, href: string, label: string): string =>
    `<a href="${href}" class="${id === active ? "on" : ""}">${label}</a>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Kupoyomi</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${CSS}</style></head><body>
<header><h1><img src="/icon-192.png" alt="" width="26" height="26">Kupoyomi</h1><nav>
  ${link("library", "/", "Library")}
  ${link("browse", "/browse", "Browse")}
  ${link("search", "/search", "Search")}
  ${link("review", "/review", "Migrations")}
  ${link("downloads", "/downloads", "Downloading")}
  ${link("queue", "/queue", "Queue")}
  ${link("extensions", "/extensions", "Sources")}
</nav><span class="sub">${subtitle}</span></header>
<main>${body}</main></body></html>`;
}
