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
/* WINDOW TITLE: centred, uppercase, gold, over the kit's separator strip. */
.card h2{font-size:12.5px;margin:-2px -6px 12px;padding:0 0 7px;font-weight:600;
  color:var(--gold);letter-spacing:2px;text-transform:uppercase;text-align:center;
  border-bottom:3px solid transparent;
  border-image:url(/ui-sep.png) 0 1 3 1 stretch}
.card a,.tile a{color:var(--gold)}
.rec{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;color:var(--gold-dim);font-weight:600;padding:6px 8px;
  border-bottom:1px solid var(--line);white-space:nowrap;font-size:11.5px;
  letter-spacing:.5px;text-transform:uppercase}
td{padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.045);vertical-align:top}
/* CharacterWindow_Title_Background and its Active sibling are flat translucent fills,
   rgba(44,41,38,.2) and rgba(67,62,59,.2), so they are CSS rather than two more images. */
tbody tr:nth-child(odd) td,table tr:nth-child(even) td{background:rgba(44,41,38,.20)}
tr:hover td{background:rgba(67,62,59,.30)}
.badge{display:inline-block;font-size:11px;padding:1px 8px;border-radius:2px;
  background:rgba(227,182,97,.10);color:var(--gold);border:1px solid rgba(227,182,97,.30)}
.actions{margin-top:12px;padding-top:10px;border-top:1px solid var(--line);
  display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.actions .hint{color:var(--ink-faint);font-size:11px}

/* Button_RM_Background.png, 128x128, border 29, fill rgb(51,46,41). This is the kit's
   own button, the one its ACCEPT / DECLINE / PLAY are drawn with: dark grey-brown with a
   thin bevel and a gold uppercase label. The green and red variants in the pack are
   colour swaps that appear nowhere in its own screens, and using one was me picking a
   file rather than looking at the design. Button_RL_Press.png is a translucent black
   wash, which is how the kit does the pressed state. */
button{font:600 11.5px/1 inherit;letter-spacing:1.1px;text-transform:uppercase;
  color:var(--gold);cursor:pointer;padding:7px 16px;background:none;white-space:nowrap;
  flex:0 0 auto;border:14px solid transparent;
  border-image:url(/ui-btn.png) 29 fill stretch;text-shadow:0 1px 2px rgba(0,0,0,.7)}
button:hover{color:#f6e6c6;filter:brightness(1.22)}
button:active{border-image:url(/ui-btn-press.png) 22 fill stretch;color:var(--gold-dim)}
/* Secondary is the same frame at a smaller size with a quieter label, since the kit has
   one button and varies its scale, not its colour. */
button.weak{padding:5px 11px;font-size:10.5px;letter-spacing:.9px;color:var(--ink-dim);
  border-width:11px}
button.weak:hover{color:var(--ink)}
button.danger{color:var(--bad)}
button.danger:hover{color:#f08a80}
button[disabled]{opacity:.35;cursor:default;filter:grayscale(.6)}

/* Input_Background.png border 33, SelectField_Background.png border 13 with the kit's own
   down arrow, which is the "YOUR REALM" field from its character select. */
input[type=search],input[type=text]{color:var(--ink);font:13px/1.3 inherit;padding:7px 11px;
  border:12px solid transparent;border-image:url(/ui-input.png) 33 fill stretch;
  background:none;max-width:100%;min-width:320px}
select{color:var(--ink);font:12.5px/1.3 inherit;padding:6px 30px 6px 11px;
  border:10px solid transparent;border-image:url(/ui-select.png) 13 fill stretch;
  background:url(/ui-select-arrow.png) no-repeat right 6px center;background-size:14px 14px;
  max-width:100%;appearance:none;-webkit-appearance:none}
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
/* The kit lists things as a gold name over a grey sub-line, which is what a cover tile
   and a search row both are. */
.lc .t,.bt .n{color:var(--gold);font-weight:600}
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
