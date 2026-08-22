import { db } from "../db.js";
import { esc, page, news } from "./layout.js";
import { fmt } from "../held.js";

export async function queuePage(): Promise<string> {
  const p = db();
  const rows = (await p.query<{ series_id: number; title: string; chapter_number: string; state: string; attempts: number; last_error: string | null; muted: boolean }>(
    `SELECT w.series_id, s.title, w.chapter_number, w.state, w.attempts, w.last_error, s.muted
       FROM wanted w JOIN series s ON s.id = w.series_id
      WHERE w.state <> 'done'
      ORDER BY (w.state = 'failed') DESC, w.attempts DESC, s.title, w.chapter_number
      LIMIT 500`)).rows;
  const counts = (await p.query<{ state: string; n: string }>(
    "SELECT state, count(*) n FROM wanted GROUP BY state")).rows;
  const stuck = rows.filter((r) => r.attempts >= 4);

  const paused = (await p.query<{ n: string }>(
    `SELECT count(*) n FROM wanted w JOIN series s ON s.id = w.series_id
      WHERE w.state <> 'done' AND s.muted`)).rows[0]?.n ?? "0";
  const summary = (counts.map((c) => `${c.state} ${c.n}`).join(" &middot; ") || "empty")
    + (Number(paused) > 0 ? ` &middot; ${paused} paused` : "");
  const body = rows.map((r) => `<tr>
    <td><a class="series" href="/series/${r.series_id}">${esc(r.title.slice(0, 46))}</a></td>
    <td>ch ${fmt(r.chapter_number)}</td>
    <td class="${r.muted ? "dim" : r.state === "failed" ? (r.attempts >= 4 ? "bad" : "warn") : "dim"}">${
      // A muted series is paused, not pending. Left as "pending" these rows sit in the
      // outstanding count forever and read as a stuck queue.
      r.muted ? "paused" : esc(r.state)}${
      r.attempts > 0 && !r.muted ? ` <span class="dim">(${r.attempts})</span>` : ""}</td>
    <td class="dim" style="font-size:11px">${esc((r.last_error ?? "").slice(0, 90))}</td></tr>`).join("");

  return page("queue", summary,
    `${stuck.length > 0 ? `<div class="card"><div class="title bad">${stuck.length} chapters have given up after 4 attempts</div>
       <div class="meta">These are not retried automatically. Usually the source stopped carrying the chapter,
       or its numbering changed.</div></div>` : ""}
     ${news("Queue", `<table><tr><th>series</th><th>chapter</th><th>state</th><th>last error</th></tr>
       ${body || '<tr><td colspan="4" class="dim">nothing queued</td></tr>'}</table>
       ${rows.length >= 500 ? '<div class="dim" style="margin-top:8px">showing the first 500</div>' : ""}`)}`);
}
