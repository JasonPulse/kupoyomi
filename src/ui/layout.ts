export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
/* RPG and MMO UI 4. Dark panels with a bronze frame, warm gold for anything that acts.
   Every frame is a nine-slice border-image measured off the source PNG rather than
   guessed: the slice numbers below are where the border stops and the flat fill starts,
   found by walking pixels in from each edge. */
:root{
  --ink:#e6ded2;          /* body text on dark */
  --ink-dim:#9b9186;      /* secondary text */
  --ink-faint:#6f665d;
  --gold:#e3b661;         /* accents, links, the active tab */
  --gold-dim:#a8863f;
  --good:#8fbf5a;
  --bad:#d1584c;
  --warn:#e0a33c;
  --line:rgba(227,182,97,.16);
}
*{box-sizing:border-box}
body{font:14px/1.55 -apple-system,system-ui,"Segoe UI",sans-serif;margin:0;color:var(--ink);
  background:#0c0b0a}

/* The header glow is a wide soft wash from the kit, laid behind the title row. */
header{padding:10px 20px 0;position:sticky;top:0;z-index:5;display:flex;gap:18px;
  align-items:flex-end;flex-wrap:wrap;background:#141210;
  border-bottom:1px solid rgba(227,182,97,.22);
  box-shadow:0 1px 0 rgba(0,0,0,.6),0 6px 18px rgba(0,0,0,.45)}
header::before{content:"";position:absolute;left:0;right:0;top:0;height:100%;
  background:url(/ui-header.png) no-repeat center top;background-size:100% 100%;
  opacity:.28;pointer-events:none}
header h1{font-size:15px;margin:0 4px 7px 0;font-weight:600;color:#f3ece1;display:flex;
  align-items:center;gap:8px;position:relative;letter-spacing:.2px}
header h1 img{border-radius:50%;display:block}
nav{display:flex;gap:2px;align-items:flex-end;flex-wrap:wrap;position:relative}
nav a{display:inline-block;height:30px;line-height:30px;padding:0 12px;font-size:12.5px;
  text-decoration:none;color:var(--ink-dim);position:relative}
nav a:hover{color:#f3ece1}
/* The active tab is the kit's menu glow plus its gold chevron, which points at the page. */
nav a.on{color:#f6e6c6;font-weight:600}
nav a.on::after{content:"";position:absolute;left:-14px;right:-14px;bottom:-1px;height:30px;
  background:url(/ui-tab-active.png) no-repeat center bottom;background-size:100% 100%;
  pointer-events:none}
.sub{color:var(--ink-faint);font-size:12px;margin-left:auto;padding-bottom:8px;position:relative}
main{padding:20px 20px 48px;max-width:1240px;margin:0 auto}

/* Window_Background.png, 128x128, border 18px on every side, fill rgb(21,19,18). */
.card,.tile{position:relative;color:var(--ink);margin:0 0 16px;
  border:18px solid transparent;
  border-image:url(/ui-panel.png) 18 fill stretch}
.card{padding:4px 6px;min-height:60px}
.tile{padding:0;margin-bottom:0}
/* ModalBox_Background.png, a heavier frame for something set inside a panel. */
.well{border:14px solid transparent;border-image:url(/ui-well.png) 36 fill stretch;
  padding:2px 4px;margin:10px 0}

.title{font-weight:600;margin-bottom:3px;color:#f3ece1;letter-spacing:.2px}
.meta,.dim,.n{color:var(--ink-dim);font-size:12px}
.card h2{font-size:14px;margin:0 0 10px;font-weight:600;color:var(--gold);
  letter-spacing:.4px;text-transform:uppercase}
.card a,.tile a{color:var(--gold)}
.rec{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;color:var(--gold-dim);font-weight:600;padding:6px 8px;
  border-bottom:1px solid var(--line);white-space:nowrap;font-size:11.5px;
  letter-spacing:.5px;text-transform:uppercase}
td{padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.055);vertical-align:top}
tr:hover td{background:rgba(227,182,97,.05)}
.badge{display:inline-block;font-size:11px;padding:1px 8px;border-radius:2px;
  background:rgba(227,182,97,.10);color:var(--gold);border:1px solid rgba(227,182,97,.30)}
.actions{margin-top:12px;padding-top:10px;border-top:1px solid var(--line);
  display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.actions .hint{color:var(--ink-faint);font-size:11px}

/* Buttom_RS_Foreground_Green.png for anything that acts, its Hover sibling on hover.
   The kit's tiny button is a flat fill with translucent overlays for its states, so the
   secondary button is those overlays in CSS and needs no image at all. */
button{font:600 12.5px/1 inherit;color:#f7f3e8;cursor:pointer;padding:8px 14px;
  border:14px solid transparent;border-image:url(/ui-btn.png) 16 fill stretch;
  background:none;white-space:nowrap;flex:0 0 auto;text-shadow:0 1px 1px rgba(0,0,0,.5)}
button:hover{border-image:url(/ui-btn-hover.png) 16 fill stretch}
button.weak{border:1px solid rgba(227,182,97,.28);border-image:none;
  background:rgba(255,255,255,.045);color:var(--ink);padding:6px 11px;border-radius:2px;
  text-shadow:none}
button.weak:hover{background:rgba(255,239,221,.09);border-color:rgba(227,182,97,.5);color:#f3ece1}
button.danger{border-image:url(/ui-btn-danger.png) 16 fill stretch}
button.danger:hover{border-image:url(/ui-btn-danger-hover.png) 16 fill stretch}
button:active{filter:brightness(.88)}
button[disabled]{opacity:.4;cursor:default;filter:grayscale(.5)}

/* Input_Background.png, 128x128, border 33px. Drawn at 12px so the bevel reads without
   eating the field. */
input[type=search],input[type=text],select{color:var(--ink);font:13px/1.3 inherit;
  padding:7px 11px;border:12px solid transparent;
  border-image:url(/ui-input.png) 33 fill stretch;background:none;max-width:100%}
input[type=search],input[type=text]{min-width:320px}
select{font-size:12.5px;padding:6px 9px}
input:focus,select:focus{outline:none;box-shadow:0 0 0 1px rgba(227,182,97,.45)}
input::placeholder{color:var(--ink-faint)}

a.series{color:var(--gold);text-decoration:none}
a.series:hover{text-decoration:underline;color:#f6e6c6}
.bar{height:6px;background:rgba(0,0,0,.5);border:1px solid rgba(227,182,97,.18);
  border-radius:2px;overflow:hidden;min-width:70px}
.bar > i{display:block;height:100%;background:linear-gradient(180deg,#e3b661,#a8863f)}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;align-items:stretch}
@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}}
.grid .tile{display:flex;flex-direction:column;justify-content:center}

/* A phone is 390px wide. The header alone used to be over that: seven tabs on one
   unwrapped row, a subtitle pushed right with margin-left:auto, and a 320px minimum on
   every search box. Each forced the document wider than the viewport. */
@media(max-width:700px){
  header{padding:8px 10px 0;gap:8px}
  header h1{font-size:14px}
  nav{gap:0}
  nav a{padding:0 8px;font-size:12px}
  .sub{margin-left:0;width:100%;padding-bottom:6px}
  main{padding:12px 8px 32px}
  .card{border-width:14px;padding:2px}
  th{white-space:normal}
  td{word-break:break-word}
  .grid{gap:8px}
  input[type=search],input[type=text]{min-width:0;width:100%}
}

/* Cover art sits in its own recessed slot, which is what the kit does with item icons. */
.lc,.bt{background:#141210;border:1px solid rgba(227,182,97,.22);
  box-shadow:0 1px 6px rgba(0,0,0,.55),inset 0 0 0 1px rgba(0,0,0,.6)}
.lc .t,.bt .n{color:var(--ink)}
.lc .s{color:var(--ink-dim)}
.cover{background:#1a1715}
.flag{display:inline-block;font-size:10.5px;padding:1px 6px;border-radius:2px;
  background:rgba(0,0,0,.7);color:var(--warn);border:1px solid rgba(224,163,60,.4)}
`;

export type Nav = "library" | "browse" | "search" | "queue" | "downloads" | "extensions";

/** A framed panel, for the primary content of a page. */
export const news = (title: string, inner: string): string =>
  `<div class="card">${title ? `<h2>${title}</h2>` : ""}${inner}</div>`;

export function page(active: Nav, subtitle: string, body: string): string {
  const link = (id: Nav, href: string, label: string): string =>
    `<a href="${href}" class="${id === active ? "on" : ""}">${label}</a>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Kupoyomi</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>${CSS}</style></head><body>
<header><h1><img src="/icon-192.png" alt="" width="26" height="26">Kupoyomi</h1><nav>
  ${link("library", "/", "Library")}
  ${link("browse", "/browse", "Browse")}
  ${link("search", "/search", "Search")}
  ${link("downloads", "/downloads", "Downloading")}
  ${link("queue", "/queue", "Queue")}
  ${link("extensions", "/extensions", "Sources")}
</nav><span class="sub">${subtitle}</span></header>
<main>${body}</main></body></html>`;
}
