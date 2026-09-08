import { db } from "../db.js";
import { esc, page, news } from "./layout.js";
import { fmt } from "../held.js";
import { maxAttempts } from "../config.js";

export async function queuePage(said?: string): Promise<string> {
  const p = db();
  const rows = (await p.query<{ series_id: number; title: string; chapter_number: string; state: string; attempts: number; last_error: string | null; retry_after: string | null; wait_min: number | null }>(
    // retry_after was in the row type and not in the query, so wait_min arrived
    // undefined every time and the "retrying in" line below could never render. A failed
    // row that is waiting looked identical to one that had been abandoned.
    `SELECT w.series_id, s.title, w.chapter_number, w.state, w.attempts, w.last_error,
            w.retry_after::text,
            CASE WHEN w.retry_after > now()
                 THEN CEIL(EXTRACT(EPOCH FROM (w.retry_after - now())) / 60)::int END AS wait_min
       FROM wanted w JOIN series s ON s.id = w.series_id
      WHERE w.state <> 'done'
      ORDER BY (w.state = 'failed') DESC, w.attempts DESC, s.title, w.chapter_number
      LIMIT 500`)).rows;
  const counts = (await p.query<{ state: string; n: string }>(
    "SELECT state, count(*) n FROM wanted GROUP BY state")).rows;
  const limit = maxAttempts();
  const stuck = rows.filter((r) => r.attempts >= limit);

  const summary = counts.map((c) => `${c.state} ${c.n}`).join(" &middot; ") || "empty";
  const body = rows.map((r) => `<tr>
    <td><a class="series" href="/series/${r.series_id}">${esc(r.title.slice(0, 46))}</a></td>
    <td>ch ${fmt(r.chapter_number)}</td>
    <td class="${r.state === "failed" ? (r.attempts >= limit ? "bad" : "warn") : "dim"}">${esc(r.state)}${
      r.attempts > 0 ? ` <span class="dim">(${r.attempts})</span>` : ""}</td>
    <td>${r.state === "failed" ? `<form method="post" action="/queue/retry">
      <input type="hidden" name="series" value="${r.series_id}">
      <input type="hidden" name="chapter" value="${esc(r.chapter_number)}">
      <button class="weak" type="submit" title="try this one now, ignoring the wait">retry</button></form>` : ""}</td>
    <td class="dim" style="font-size:11px">${esc((r.last_error ?? "").slice(0, 90))}${
      // A failed row that is waiting says so, because otherwise it reads as abandoned.
      r.wait_min && r.wait_min > 0
        ? `<div>retrying in ${r.wait_min < 60 ? `${r.wait_min}m` : `${Math.round(r.wait_min / 60)}h`}</div>`
        : ""}</td></tr>`).join("");

  return page("queue", summary,
    `${said ? `<div class="card" style="min-height:0;padding:6px 4px"><div class="meta"><b>${esc(said)}</b></div></div>` : ""}
     ${stuck.length > 0 ? `<div class="card"><div class="title bad">${stuck.length} chapters are out of attempts</div>
       <div class="meta">Each gets one more try after two days, or sooner when the queue has nothing
       else to do. Usually the source stopped carrying the chapter, or its numbering changed.</div></div>` : ""}
     ${news("Queue", `<table><tr><th>series</th><th>chapter</th><th>state</th><th></th><th>last error</th></tr>
       ${body || '<tr><td colspan="5" class="dim">nothing queued</td></tr>'}</table>
       ${rows.length >= 500 ? '<div class="dim" style="margin-top:8px">showing the first 500</div>' : ""}`)}`);
}
