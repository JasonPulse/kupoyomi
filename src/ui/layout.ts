export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
*{box-sizing:border-box}
body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#111;color:#ddd}
header{padding:9px 20px 0;background:#1b1b1b;border-bottom:1px solid #3a3428;position:sticky;top:0;z-index:5;
  display:flex;gap:18px;align-items:flex-end;flex-wrap:wrap}
header h1{font-size:15px;margin:0 4px 5px 0;font-weight:600;color:#eee;display:flex;align-items:center;gap:8px}
header h1 img{border-radius:50%;display:block}
/* Tabs cut from the FFXI news header: the parchment strip 9-sliced so it stretches to
   the label, with the moogle as the active tab's left cap. */
nav{display:flex;gap:3px;align-items:flex-end}
nav a{display:inline-block;height:26px;line-height:26px;font-size:12.5px;text-decoration:none;
  color:#6d6055;border-style:solid;border-width:0 20px 0 20px;
  border-image:url(/tab-off.png) 0 20 0 20 fill stretch;
  filter:saturate(.9)}
nav a:hover{color:#cbbfa8;filter:brightness(1.35)}
nav a.on{color:#2b2318;font-weight:700;border-width:0 22px 0 30px;
  border-image-source:url(/tab-on.png);border-image-slice:0 22 0 30;filter:none}
.sub{color:#888;font-size:12px;margin-left:auto;padding-bottom:6px}
main{padding:18px 20px;max-width:1200px}
.card{background:#1a1a1a;border:1px solid #2e2e2e;border-radius:6px;margin-bottom:14px;padding:14px}
.title{font-weight:600;margin-bottom:2px}
.meta{color:#888;font-size:12px;margin-bottom:10px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;color:#888;font-weight:500;padding:5px 8px;border-bottom:1px solid #333;white-space:nowrap}
td{padding:5px 8px;border-bottom:1px solid #242424;vertical-align:top}
tr:hover td{background:#1e1e1e}
.rec{color:#7ec699}.bad{color:#c98b7e}.dim{color:#777}.warn{color:#c9b27e}
.badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:9px;background:#232;color:#9b9;border:1px solid #343}
.actions{margin-top:10px;padding-top:9px;border-top:1px solid #262626;display:flex;gap:8px;align-items:center}
.actions .hint{color:#666;font-size:11px}
button{background:#2b6;border:0;color:#052;font-weight:600;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:13px}
button.weak{background:#3a3a3a;color:#bbb}
button:hover{filter:brightness(1.15)}
input[type=search],input[type=text]{background:#0d0d0d;border:1px solid #3a3a3a;color:#eee;
  padding:6px 10px;border-radius:4px;font-size:13px;min-width:320px}
a.series{color:#cde;text-decoration:none}a.series:hover{text-decoration:underline}
.bar{height:5px;background:#2a2a2a;border-radius:3px;overflow:hidden;min-width:70px}
.bar > i{display:block;height:100%;background:#2b6}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.tile{background:#1a1a1a;border:1px solid #2e2e2e;border-radius:6px;padding:11px}
.tile .n{font-size:12px;color:#888}
`;

export type Nav = "library" | "browse" | "search" | "review" | "queue" | "downloads" | "extensions";

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
