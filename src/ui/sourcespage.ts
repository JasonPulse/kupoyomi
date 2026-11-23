import { db } from "../db.js";
import { esc, page, news } from "./layout.js";
import { fmt } from "../held.js";
import { moveOffJob, seriesOn } from "../moveoff.js";

type Status = {
  source_id: string; source_name: string; series: number;
  failures: number | null; down_since: string | null; last_error: string | null; checked_at: string | null;
};

/** Every source a series depends on, from the hourly probe. Down first. */
export const sourceStatuses = async (): Promise<Status[]> =>
  (await db().query<Status>(
    `SELECT b.source_id, min(b.source_name) AS source_name, count(*)::int AS series,
            max(st.failures) AS failures, max(st.down_since)::text AS down_since,
            max(st.last_error) AS last_error, max(st.checked_at)::text AS checked_at
       FROM series_binding b LEFT JOIN source_status st ON st.source_id = b.source_id
      WHERE b.role = 'active'
      GROUP BY b.source_id
      ORDER BY COALESCE(max(st.failures), 0) > 0 DESC, count(*) DESC, min(b.source_name)`)).rows;

const isDown = (s: { failures: number | null }): boolean => (s.failures ?? 0) > 0;

/** The one-line warning the extensions page carries when any host is down. */
export async function downBanner(): Promise<string> {
  const down = (await sourceStatuses().catch(() => [])).filter(isDown);
  if (down.length === 0) return "";
  return `<div class="card"><div class="title bad">${down.length} source${down.length === 1 ? "" : "s"} your series use
    ${down.length === 1 ? "is" : "are"} not answering</div><div class="meta">${
    down.map((s) => `<a class="series" href="/sources/${encodeURIComponent(s.source_id)}">${esc(s.source_name)}</a> (${s.series})`).join(", ")
    }. <a href="/sources">See every source</a></div></div>`;
}

export async function sourcesPage(): Promise<string> {
  const rows = await sourceStatuses();
  const down = rows.filter(isDown).length;
  const body = rows.map((s) => `<tr>
    <td><a class="series" href="/sources/${encodeURIComponent(s.source_id)}">${esc(s.source_name)}</a></td>
    <td>${s.series}</td>
    <td class="${isDown(s) ? "bad" : s.checked_at ? "rec" : "dim"}">${
      isDown(s) ? `down since ${esc((s.down_since ?? "").slice(0, 16))}` : s.checked_at ? "answering" : "not checked yet"}</td>
    <td class="dim" style="font-size:11px">${esc((s.last_error ?? "").slice(0, 90))}</td></tr>`).join("");
  return page("extensions", down > 0 ? `${down} of ${rows.length} sources down` : `${rows.length} sources in use`,
    news("Sources your series use", `<div class="meta">Each one is asked for its popular list every hour.
      Two failures in a row counts as down and sends one alert; another goes out when it comes back.</div>
      <table style="margin-top:10px"><tr><th>source</th><th>series</th><th>state</th><th>last error</th></tr>
      ${body || '<tr><td colspan="4" class="dim">no series are bound to a source</td></tr>'}</table>`));
}

const replacementLine = (r: { sourceName: string; chapters: number; highest: number | null; lastUpload: string | null;
  newBeyond: number; fillsGaps: number; notCarried: number }): string =>
  `<b>${esc(r.sourceName)}</b> <span class="dim">${r.chapters} chapters${
    r.highest !== null ? `, up to ${fmt(r.highest)}` : ""}${r.lastUpload ? `, newest ${esc(r.lastUpload)}` : ""}</span>
   <span class="${r.newBeyond > 0 ? "rec" : "dim"}">${r.newBeyond} past yours</span>${
    r.fillsGaps > 0 ? ` <span class="rec">fills ${r.fillsGaps} gaps</span>` : ""}${
    r.notCarried > 0 ? ` <span class="warn">${r.notCarried} you hold it lacks</span>` : ""}`;

export async function moveOffPage(sourceId: string, said?: string): Promise<string> {
  const status = (await sourceStatuses()).find((s) => s.source_id === sourceId);
  const job = moveOffJob(sourceId);
  const name = status?.source_name ?? job?.sourceName ?? sourceId;
  const running = job !== undefined && !job.finishedAt;
  const state = status && isDown(status)
    ? `<span class="bad">down since ${esc((status.down_since ?? "").slice(0, 16))}</span> <span class="dim">${esc((status.last_error ?? "").slice(0, 120))}</span>`
    : status?.checked_at ? '<span class="rec">answering</span>' : '<span class="dim">not checked yet</span>';

  let inner: string;
  if (!job) {
    const series = await seriesOn(sourceId);
    inner = `<div class="meta">${series.length} series use ${esc(name)}: ${
      series.map((s) => `<a class="series" href="/series/${s.id}">${esc(s.title)}</a>`).join(", ") || "none"}.</div>
      <form method="post" action="/sources/${encodeURIComponent(sourceId)}/find" style="margin-top:10px">
        <button type="submit"${series.length === 0 ? " disabled" : ""}>find another source for each</button>
        <span class="hint">Searches every other source for each title, one series at a time. A few minutes
        per series. Nothing switches until you pick.</span></form>`;
  } else {
    const done = job.series.filter((l) => l.state !== "waiting" && l.state !== "searching").length;
    const cards = job.series.map((l) => {
      const head = `<div class="title"><a class="series" href="/series/${l.seriesId}">${esc(l.title)}</a>
        <span class="dim">${l.held} chapters held</span></div>`;
      if (l.state === "moved") return `<div class="card">${head}<div class="meta rec">moved to ${esc(l.movedTo ?? "")}</div></div>`;
      if (l.state === "waiting" || l.state === "searching") {
        return `<div class="card">${head}<div class="meta dim">${l.state === "searching" ? "searching every source" : "waiting its turn"}</div></div>`;
      }
      const manual = `<a href="/search?q=${encodeURIComponent(l.title)}&series=${l.seriesId}">search by hand</a>`;
      if (l.candidates.length === 0) {
        return `<div class="card">${head}<div class="meta">No other source lists this exact title. ${manual}</div></div>`;
      }
      // The first is checked because it is the furthest along. Keeping the current source
      // is always an option, since a host that is down today may be back tomorrow.
      const opts = l.candidates.map((r, i) => `<label style="display:block;margin:4px 0">
        <input type="radio" name="pick_${l.seriesId}" value="${i}"${i === 0 ? " checked" : ""}> ${replacementLine(r)}</label>`).join("");
      return `<div class="card">${head}${opts}
        <label style="display:block;margin:4px 0"><input type="radio" name="pick_${l.seriesId}" value="-1">
          <span class="dim">stay on ${esc(name)}</span></label><div class="meta">${manual}</div></div>`;
    }).join("");
    const pickable = job.series.some((l) => l.state === "done" && l.candidates.length > 0);
    inner = `<div class="meta">${running ? `Searching: ${done} of ${job.series.length} series done. This page refreshes itself.`
        : `Finished ${esc(job.finishedAt!.slice(0, 16))}.`}${
        job.error ? ` <span class="bad">The search stopped early: ${esc(job.error.slice(0, 160))}</span>` : ""}
      Files already held stay where they are, and a new source only fills chapters you do not have.</div>
      <form method="post" action="/sources/${encodeURIComponent(sourceId)}/move" style="margin-top:10px">
        ${cards}
        ${pickable ? '<button type="submit">switch the checked sources</button>' : ""}
      </form>
      ${running ? "" : `<form method="post" action="/sources/${encodeURIComponent(sourceId)}/find" style="margin-top:8px">
        <button class="weak" type="submit">search again</button></form>`}`;
  }

  return page("extensions", esc(name),
    `${running ? '<meta http-equiv="refresh" content="10">' : ""}
     ${said ? `<div class="card" style="min-height:0;padding:6px 4px"><div class="meta"><b>${esc(said)}</b></div></div>` : ""}
     ${news(`Move series off ${esc(name)}`, `<div class="meta">${state}</div>${inner}`)}`);
}
