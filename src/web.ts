import { db } from "./db.js";
import { confirmCandidate } from "./confirm.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CSS = `
body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;background:#111;color:#ddd}
header{padding:14px 20px;background:#1b1b1b;border-bottom:1px solid #333;position:sticky;top:0}
h1{font-size:16px;margin:0;font-weight:600}
.sub{color:#888;font-size:12px;margin-top:3px}
main{padding:20px;max-width:1100px}
.card{background:#1a1a1a;border:1px solid #2e2e2e;border-radius:6px;margin-bottom:14px;padding:14px}
.title{font-weight:600;margin-bottom:2px}
.meta{color:#888;font-size:12px;margin-bottom:10px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{text-align:left;color:#888;font-weight:500;padding:4px 8px;border-bottom:1px solid #333}
td{padding:5px 8px;border-bottom:1px solid #242424;vertical-align:top}
.rec{color:#7ec699}.bad{color:#c98b7e}.dim{color:#777}
button{background:#2b6;border:0;color:#062;font-weight:600;padding:4px 10px;border-radius:4px;cursor:pointer}
button.weak{background:#444;color:#bbb}
.latest{color:#777;font-size:11px;white-space:pre-line}
a{color:#6ab}
`;

type CandRow = {
  id: number; folder: string; dead_source: string | null; file_count: number; resolved_title: string | null;
};
type CmpRow = {
  candidate_id: number; manga_id: number; source_name: string; chapters: number;
  range_lo: string | null; range_hi: string | null; gaps: number;
  latest: Array<{ chapter: number | null; uploaded: string; scanlator: string | null }>; note: string | null;
};

export async function reviewPage(): Promise<string> {
  const p = db();
  const cands = (await p.query<CandRow>(
    `SELECT id, folder, dead_source, file_count, resolved_title FROM import_candidate
      WHERE confirmed_series_id IS NULL ORDER BY file_count DESC`)).rows;
  const cmps = (await p.query<CmpRow>(
    `SELECT candidate_id, manga_id, source_name, chapters, range_lo, range_hi, gaps, latest, note
       FROM candidate_comparison ORDER BY chapters DESC`)).rows;
  const done = (await p.query<{ n: string }>("SELECT count(*) n FROM import_candidate WHERE confirmed_series_id IS NOT NULL")).rows[0];
  const led = (await p.query<{ s: string; c: string }>(
    "SELECT (SELECT count(*) FROM series) s, (SELECT count(*) FROM chapter) c")).rows[0];

  const byCand = new Map<number, CmpRow[]>();
  for (const c of cmps) {
    const l = byCand.get(c.candidate_id);
    if (l) l.push(c); else byCand.set(c.candidate_id, [c]);
  }

  const cards = cands.map((k) => {
    const opts = byCand.get(k.id) ?? [];
    const title = k.resolved_title ?? k.folder;
    // Recommendation, not a decision: a source holding less than you already own
    // would strand you again, so it is called out rather than hidden.
    const best = opts.filter((o) => o.chapters > 0).sort((a, b) => b.chapters - a.chapters)[0];
    const rows = opts.length === 0
      ? `<tr><td colspan="5" class="dim">no exact-title match on any live source</td></tr>`
      : opts.map((o) => {
          const strong = o.chapters >= k.file_count * 0.8;
          const cls = o.chapters === 0 ? "bad" : strong ? "rec" : "";
          const latest = (o.latest ?? []).slice(0, 3)
            .map((l) => `ch ${l.chapter ?? "?"}  ${l.uploaded}  ${l.scanlator ?? "-"}`).join("\n");
          return `<tr>
            <td class="${cls}">${esc(o.source_name)}${o === best && strong ? " &larr; recommended" : ""}</td>
            <td class="${cls}">${o.chapters}</td>
            <td class="dim">${o.range_lo ?? "-"}&ndash;${o.range_hi ?? "-"}</td>
            <td class="dim">${o.gaps}</td>
            <td class="latest">${esc(latest || o.note || "")}</td>
            <td><form method="post" action="/confirm">
              <input type="hidden" name="id" value="${k.id}">
              <input type="hidden" name="pick" value="${o.manga_id}">
              <button class="${strong ? "" : "weak"}" type="submit">use this</button>
            </form></td></tr>`;
        }).join("");
    return `<div class="card">
      <div class="title">${esc(title)}</div>
      <div class="meta">${k.file_count} files stranded under ${esc(k.dead_source ?? "-")}</div>
      <table><tr><th>source</th><th>chapters</th><th>range</th><th>gaps</th><th>recent uploads</th><th></th></tr>
      ${rows}</table></div>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Kupoyomi review</title>
    <meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}</style></head><body>
    <header><h1>Kupoyomi &mdash; migration review</h1>
      <div class="sub">${cands.length} awaiting a decision &middot; ${done?.n ?? 0} confirmed &middot;
      ledger ${led?.s ?? 0} series / ${led?.c ?? 0} chapters</div></header>
    <main>${cards || "<p class=dim>nothing awaiting confirmation.</p>"}</main></body></html>`;
}

export async function handleConfirmPost(body: string): Promise<string> {
  const params = new URLSearchParams(body);
  const id = Number(params.get("id"));
  const pick = Number(params.get("pick"));
  if (!Number.isInteger(id) || !Number.isInteger(pick)) throw new Error("bad form");
  await confirmCandidate(id, pick);
  return "/";
}
