import { createServer } from "node:http";
import { db } from "./db.js";
import { installedExtensions, installExtension, serverAbout, fetchExtensionIndex } from "./suwayomi.js";
import { reviewPage, handleConfirmPost, handleArchivePost } from "./web.js";
import { libraryPage } from "./ui/library.js";
import { addSeries } from "./ui/search.js";
import { searchPage } from "./ui/searchpage.js";
import { streamSearch, mangaDetail } from "./ui/searchstream.js";
import { seriesPage } from "./ui/series.js";
import { queuePage } from "./ui/queue.js";
import { downloadsPage, liveState } from "./ui/downloads.js";
import { browseIndex, browseSource, streamBrowse } from "./ui/browse.js";
import { previewPage } from "./ui/preview.js";
import { confirmRemovalPage } from "./ui/remove.js";
import { gapsPage } from "./ui/gaps.js";
import { queueGapFill } from "./gaps.js";
import { removeSeries } from "./remove.js";
import { extensionsPage, setExtension } from "./ui/extensions.js";
import { ASSETS } from "./ui/assets.js";
import { serveBundle } from "./ui/pbrepo.js";
import { refreshMetadata } from "./metadata.js";
import { listSeries, getSeries, getChapters, getPages, getPage, setProgress, setProgressUpTo, clearProgress, lastReadChapter, bindingAvailability } from "./pbapi.js";
import { createReadStream } from "node:fs";
import { scanWanted, reclaimStuck } from "./fetch.js";
import { startScheduler, state as schedState, checkStalled } from "./schedule.js";

/**
 * Suwayomi runs on emptyDir, so on every cold start it comes up with no extensions
 * at all. Replaying the declared set is what makes that survivable without anyone
 * logging into a UI and guessing which extensions they used last time.
 */
export async function reconcileExtensions(): Promise<{ desired: number; installed: number; unavailable: string[] }> {
  const desired = (await db().query<{ pkg_name: string }>(
    "SELECT pkg_name FROM extension WHERE desired ORDER BY pkg_name")).rows.map((r) => r.pkg_name);
  const present = new Set((await installedExtensions()).map((e) => e.pkgName));
  const missing = desired.filter((p) => !present.has(p));
  if (missing.length === 0) return { desired: desired.length, installed: 0, unavailable: [] };

  // Only now prime the repo index. A cold Suwayomi reports no available extensions
  // at all, so an install issued before this fails on an unknown package name --
  // but pulling a 1372-entry index on every steady-state check is pure waste.
  await fetchExtensionIndex();

  const failed: string[] = [];
  for (const pkg of missing) {
    try {
      await installExtension(pkg);
      await db().query("UPDATE extension SET last_installed_at = now() WHERE pkg_name = $1", [pkg]);
    } catch {
      // An extension keiyoushi has removed cannot be reinstalled at any price. That
      // is a dead source, not a transient error, so record it and carry on.
      failed.push(pkg);
    }
  }
  return { desired: desired.length, installed: missing.length - failed.length, unavailable: failed };
}

type Reconcile = { at: string; desired?: number; installed?: number; unavailable?: string[]; error?: string };
let lastReconcile: Reconcile = { at: "never", error: "not yet attempted" };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Suwayomi runs on emptyDir and boots a JVM, so at Kupoyomi's startup it is usually
 * not answering yet, and it can restart at any time and lose every extension. A
 * one-shot bootstrap silently leaves it empty forever, so this retries until it
 * lands and then keeps checking, which is what makes the ephemeral data directory
 * actually safe.
 */
async function bootstrapLoop(): Promise<void> {
  const RECHECK_MS = 15 * 60 * 1000;
  let backoff = 5000;
  for (;;) {
    try {
      const r = await reconcileExtensions();
      lastReconcile = { at: new Date().toISOString(), ...r };
      if (r.installed > 0 || r.unavailable.length > 0) {
        console.log(`extensions: installed ${r.installed} of ${r.desired} declared` +
          (r.unavailable.length > 0 ? `; ${r.unavailable.length} removed upstream: ${r.unavailable.join(", ")}` : ""));
      }
      backoff = 5000;
      await sleep(RECHECK_MS);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lastReconcile = { at: new Date().toISOString(), error: message };
      console.error(`extension reconcile failed (${message}); retrying in ${backoff / 1000}s`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

const stats = async (): Promise<Record<string, unknown>> => {
  const q = async (sql: string): Promise<number> =>
    Number((await db().query<{ n: string }>(sql)).rows[0]?.n ?? 0);
  return {
    series: await q("SELECT count(*) n FROM series"),
    chapters: await q("SELECT count(*) n FROM chapter"),
    pending_confirmation: await q("SELECT count(*) n FROM import_candidate WHERE confirmed_series_id IS NULL"),
    needs_review: await q("SELECT count(*) n FROM import_candidate WHERE match_kind = 'review' AND confirmed_series_id IS NULL"),
    stalled: await q("SELECT count(*) n FROM series WHERE stalled_since IS NOT NULL AND NOT muted"),
    extensions_desired: await q("SELECT count(*) n FROM extension WHERE desired"),
    // Stopping a series deletes its outstanding rows, so this needs no muted clause and
    // there is no second bucket to report.
    wanted_outstanding: await q("SELECT count(*) n FROM wanted WHERE state <> 'done'"),
    wanted_failed: await q("SELECT count(*) n FROM wanted WHERE state = 'failed' AND attempts >= 4"),
    last_reconcile: lastReconcile,
    scheduler: schedState,
  };
};

export async function serve(): Promise<void> {
  const port = Number(process.env["PORT"] ?? 8080);

  // Deliberately not awaited: the health endpoint has to come up regardless of
  // whether Suwayomi is answering yet, or the probe cannot tell "still booting"
  // from "broken".
  void bootstrapLoop();
  // Nothing can own a "fetching" row before this process starts, so every one of them
  // is a leftover. Rolling the pod mid-chapter used to leave a row claiming to be
  // downloading indefinitely.
  void reclaimStuck(0).catch(() => undefined);
  if (process.env["SCHEDULER"] !== "off") startScheduler();
  else console.log("scheduler: disabled by SCHEDULER=off");
  serverAbout().then((a) => console.log(`suwayomi ${a.version} (${a.revision})`)).catch(() => {});

  // Resolves once. A second call on the same request would wait forever on an "end" that
  // has already fired, which presents as a route that hangs rather than one that errors.
  const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      if (req.readableEnded) { resolve(""); return; }
      let b = "";
      req.on("data", (c) => { b += c; });
      req.on("end", () => resolve(b));
    });

  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const html = (p: Promise<string>): void => {
      p.then((h) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(h); })
       .catch((e: unknown) => send(500, { error: e instanceof Error ? e.message : String(e) }));
    };
    const redirect = (to: string): void => { res.writeHead(303, { location: to }); res.end(); };

    if (path === "/healthz") return send(200, { ok: true });

    // The Paperback repository: add https://<host>/paperback/ as a source in the app.
    if (path === "/paperback" || path.startsWith("/paperback/")) {
      const file = serveBundle(path.replace(/^\/paperback/, ""));
      if (!file) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not in the bundle"); return; }
      res.writeHead(200, { "content-type": file.type, "cache-control": "public, max-age=300" });
      res.end(file.body);
      return;
    }

    const asset = ASSETS[path];
    if (asset) {
      res.writeHead(200, { "content-type": asset.type, "cache-control": "public, max-age=86400" });
      res.end(asset.body);
      return;
    }

    // Covers are served by Suwayomi, whose paths mean nothing to a browser pointed at
    // us, so they are proxied. Cached hard: a cover for a given manga does not change.
    const th = /^\/thumb\/(\d+)$/.exec(path);
    if (th) {
      const base = (process.env["SUWAYOMI_URL"] ?? "").replace(/\/api\/graphql\/?$/, "");
      fetch(`${base}/api/v1/manga/${th[1]}/thumbnail`)
        .then(async (r) => {
          if (!r.ok) { res.writeHead(r.status); res.end(); return; }
          res.writeHead(200, {
            "content-type": r.headers.get("content-type") ?? "image/jpeg",
            "cache-control": "public, max-age=604800, immutable",
          });
          res.end(Buffer.from(await r.arrayBuffer()));
        })
        .catch(() => { res.writeHead(502); res.end(); });
      return;
    }
    if (path === "/api/stats") {
      stats().then((s) => send(200, s)).catch((e: unknown) =>
        send(503, { error: e instanceof Error ? e.message : String(e) }));
      return;
    }

    // The Paperback extension's API. Kept under one prefix so it is obvious what is
    // public contract and what is internal to the web UI.
    if (path.startsWith("/api/pb/")) {
      // Logged, because the alternative is guessing. When read state failed to arrive
      // from the app there was no way to tell a request that failed from one the app
      // never made. Page and cover reads are excluded: a chapter is 30 of them and the
      // log would be nothing else.
      if (!/^\/api\/pb\/(page|cover)\//.test(path)) {
        const started = Date.now();
        res.on("finish", () => console.log(
          `pb ${req.method} ${path}${url.search} -> ${res.statusCode} in ${Date.now() - started}ms`));
      }
      const pb = async (): Promise<void> => {
        const parts = path.split("/").filter(Boolean).slice(2);   // after api/pb
        if (parts[0] === "series" && parts.length === 1) return send(200, await listSeries(url.searchParams.get("q") ?? undefined));
        if (parts[0] === "series" && parts[1] && parts.length === 2) {
          const s = await getSeries(Number(parts[1]));
          return s ? send(200, s) : send(404, { error: "no such series" });
        }
        if (parts[0] === "series" && parts[1] && parts[2] === "progress") {
          const n = await lastReadChapter(Number(parts[1]));
          return send(200, { lastReadChapter: n });
        }
        if (parts[0] === "series" && parts[1] && parts[2] === "chapters") {
          return send(200, await getChapters(Number(parts[1])));
        }
        if (parts[0] === "chapter" && parts[1] && parts[2]) {
          const pages = await getPages(Number(parts[1]), decodeURIComponent(parts[2]));
          return pages ? send(200, { pages }) : send(404, { error: "no such chapter" });
        }
        if (parts[0] === "page" && parts[1] && parts[2] && parts[3] !== undefined) {
          const img = await getPage(Number(parts[1]), decodeURIComponent(parts[2]), Number(parts[3]));
          if (!img) return send(404, { error: "no such page" });
          res.writeHead(200, { "content-type": img.type, "cache-control": "public, max-age=86400" });
          res.end(img.body);
          return;
        }
        if (parts[0] === "cover" && parts[1]) {
          const r = await db().query<{ cover_path: string | null }>(
            "SELECT cover_path FROM series WHERE id = $1", [Number(parts[1])]);
          const cp = r.rows[0]?.cover_path;
          if (!cp) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=3600" });
          createReadStream(cp).on("error", () => { res.writeHead(404); res.end(); }).pipe(res);
          return;
        }
        if (parts[0] === "progress" && parts[1] === "upto" && req.method === "POST") {
          const body = await readBody(req);
          const f = new URLSearchParams(body);
          const j = body.trim().startsWith("{") ? JSON.parse(body) as Record<string, unknown> : null;
          const seriesId = Number(j?.["seriesId"] ?? f.get("seriesId"));
          const chapter = String(j?.["chapter"] ?? f.get("chapter") ?? "");
          if (!Number.isInteger(seriesId) || !chapter) return send(400, { error: "seriesId and chapter required" });
          const marked = await setProgressUpTo(seriesId, chapter);
          return send(200, { ok: true, marked });
        }
        if (parts[0] === "progress" && parts[1] === "clear" && req.method === "POST") {
          const body = await readBody(req);
          const f = new URLSearchParams(body);
          const j = body.trim().startsWith("{") ? JSON.parse(body) as Record<string, unknown> : null;
          const seriesId = Number(j?.["seriesId"] ?? f.get("seriesId"));
          const chapter = String(j?.["chapter"] ?? f.get("chapter") ?? "");
          if (!Number.isInteger(seriesId) || !chapter) return send(400, { error: "seriesId and chapter required" });
          await clearProgress(seriesId, chapter);
          return send(200, { ok: true });
        }
        if (parts[0] === "progress" && req.method === "POST") {
          const body = await readBody(req);
          const f = new URLSearchParams(body);
          const j = body.trim().startsWith("{") ? JSON.parse(body) as Record<string, unknown> : null;
          const seriesId = Number(j?.["seriesId"] ?? f.get("seriesId"));
          const chapter = String(j?.["chapter"] ?? f.get("chapter") ?? "");
          const page = Number(j?.["page"] ?? f.get("page") ?? 0);
          const completed = String(j?.["completed"] ?? f.get("completed") ?? "false") === "true";
          if (!Number.isInteger(seriesId) || !chapter) return send(400, { error: "seriesId and chapter required" });
          await setProgress(seriesId, chapter, page, completed);
          return send(200, { ok: true });
        }
        return send(404, { error: "unknown endpoint" });
      };
      pb().catch((e: unknown) => send(500, { error: e instanceof Error ? e.message : String(e) }));
      return;
    }

    if (req.method === "GET") {
      if (path === "/") return html(libraryPage(url.searchParams.get("q") ?? undefined, url.searchParams.get("view") ?? "grid"));
      if (path === "/search") return html(searchPage(url.searchParams.get("q") ?? undefined));
      if (path === "/api/search") {
        streamSearch(res, url.searchParams.get("q") ?? "").catch(() => res.end());
        return;
      }
      if (path === "/api/detail") {
        const id = Number(url.searchParams.get("mangaId"));
        if (!Number.isInteger(id)) return send(400, { error: "mangaId required" });
        mangaDetail(id).then((d) => send(200, d))
          .catch((e: unknown) => send(200, { chapters: null, error: e instanceof Error ? e.message : String(e) }));
        return;
      }
      if (path === "/review") return html(reviewPage());
      if (path === "/queue") return html(queuePage());
      if (path === "/downloads") return html(downloadsPage());
      if (path === "/api/live") {
        liveState().then((d) => send(200, d))
          .catch((e: unknown) => send(503, { error: e instanceof Error ? e.message : String(e) }));
        return;
      }
      if (path === "/browse") return html(browseIndex());
      if (path === "/preview") {
        return html(previewPage(url.searchParams.get("source") ?? "",
          url.searchParams.get("url") ?? "", url.searchParams.get("title") ?? ""));
      }
      if (path === "/extensions") {
        return html(extensionsPage({
          ...(url.searchParams.get("q") ? { q: url.searchParams.get("q")! } : {}),
          ...(url.searchParams.get("nsfw") === "0" ? { nsfw: false } : {}),
          ...(url.searchParams.get("installed") ? { installed: true } : {}),
        }));
      }
      if (path === "/api/browse") {
        streamBrowse(res, url.searchParams.get("source") ?? "",
          url.searchParams.get("type") ?? "POPULAR", url.searchParams.getAll("f")).catch(() => res.end());
        return;
      }
      const b = /^\/browse\/(.+)$/.exec(path);
      if (b) {
        return html(browseSource(decodeURIComponent(b[1]!),
          url.searchParams.get("type") ?? "POPULAR", url.searchParams.getAll("f")));
      }
      const bav = /^\/api\/binding\/(\d+)$/.exec(path);
      if (bav) {
        bindingAvailability(Number(bav[1])).then((d) => send(200, d))
          .catch((e: unknown) => send(200, { error: e instanceof Error ? e.message : String(e) }));
        return;
      }
      const cover = /^\/series\/(\d+)\/cover$/.exec(path);
      if (cover) {
        db().query<{ cover_path: string | null }>("SELECT cover_path FROM series WHERE id = $1", [Number(cover[1])])
          .then((r) => {
            const p2 = r.rows[0]?.cover_path;
            if (!p2) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=3600" });
            createReadStream(p2).on("error", () => { res.writeHead(404); res.end(); }).pipe(res);
          })
          .catch(() => { res.writeHead(500); res.end(); });
        return;
      }
      const gp = /^\/series\/(\d+)\/gaps$/.exec(path);
      if (gp) return html(gapsPage(Number(gp[1])));
      const rem = /^\/series\/(\d+)\/remove$/.exec(path);
      if (rem) return html(confirmRemovalPage(Number(rem[1])));
      const m = /^\/series\/(\d+)$/.exec(path);
      if (m) return html(seriesPage(Number(m[1])));
    }

    if (req.method === "POST") {
      const act = async (): Promise<string> => {
        const body = await readBody(req);
        const form = new URLSearchParams(body);
        if (path === "/confirm") return handleConfirmPost(body);
        if (path === "/archive") return handleArchivePost(body);
        if (path === "/add") {
          const id = await addSeries({
            title: form.get("title") ?? "", sourceId: form.get("sourceId") ?? "",
            sourceName: form.get("sourceName") ?? "", url: form.get("url") ?? "",
          });
          // Queue what the source has and fetch the cover, but do not make the caller
          // wait: adding from a search should be instant so several can be added in a row.
          void scanWanted({ seriesId: id }).catch(() => undefined);
          void refreshMetadata(id).catch(() => undefined);
          return `/series/${id}`;
        }
        const scan = /^\/series\/(\d+)\/scan$/.exec(path);
        if (scan) { await scanWanted({ seriesId: Number(scan[1]) }); return `/series/${scan[1]}`; }
        if (path === "/extensions/install" || path === "/extensions/uninstall") {
          await setExtension(form.get("pkg") ?? "", path.endsWith("install"));
          return "/extensions";
        }
        const doGaps = /^\/series\/(\d+)\/gaps$/.exec(path);
        if (doGaps) {
          const sid = Number(doGaps[1]);
          const numbers = (form.get("numbers") ?? "").split(",").map(Number).filter(Number.isFinite);
          await queueGapFill(sid, {
            sourceId: form.get("sourceId") ?? "", sourceName: form.get("sourceName") ?? "",
            url: form.get("url") ?? "",
          }, numbers);
          return `/series/${sid}`;
        }
        const doRemove = /^\/series\/(\d+)\/remove$/.exec(path);
        if (doRemove) {
          await removeSeries(Number(doRemove[1]), {
            files: form.get("files") === "1", legacy: form.get("legacy") === "1",
          });
          return "/";
        }
        const promote = /^\/series\/(\d+)\/promote$/.exec(path);
        if (promote) {
          const bid = Number(form.get("binding"));
          const sid = Number(promote[1]);
          // Exactly one primary is a database constraint, so the incumbent steps down first.
          await db().query("UPDATE series_binding SET role='supplemental' WHERE series_id=$1 AND role='primary'", [sid]);
          await db().query("UPDATE series_binding SET role='primary' WHERE id=$1 AND series_id=$2", [bid, sid]);
          // A promotion with no scan behind it changes a row and nothing else: the whole
          // point of switching source is what the new one carries, and until something
          // scans, the queue still reflects the old one. Not awaited, so the page comes
          // straight back rather than sitting on a live search.
          void scanWanted({ seriesId: sid }).catch(() => undefined);
          return `/series/${sid}`;
        }
        const meta = /^\/series\/(\d+)\/metadata$/.exec(path);
        if (meta) { await refreshMetadata(Number(meta[1])); return `/series/${meta[1]}`; }
        const read = /^\/series\/(\d+)\/read$/.exec(path);
        if (read) {
          // form, not readBody: the body is consumed once at the top of this handler, and
          // reading it again waits on an "end" event that has already fired, so the
          // request hangs until the client gives up.
          const chapter = (form.get("chapter") ?? "").trim();
          // A blank box is not a request to mark nothing read, it is a mistake, so it
          // does nothing rather than quietly marking chapter 0.
          if (chapter) await setProgressUpTo(Number(read[1]), chapter);
          return `/series/${read[1]}`;
        }
        const mute = /^\/series\/(\d+)\/mute$/.exec(path);
        if (mute) {
          const sid = Number(mute[1]);
          const now = (await db().query<{ muted: boolean }>(
            "UPDATE series SET muted = NOT muted WHERE id = $1 RETURNING muted", [sid])).rows[0];
          // Stopping discards the backlog rather than parking it. A queue that keeps rows
          // it will never act on is a queue you cannot read. Nothing is lost: the rows are
          // derived from what the source carries, so starting again and scanning rebuilds
          // exactly what is still missing.
          if (now?.muted) {
            await db().query("DELETE FROM wanted WHERE series_id = $1 AND state <> 'done'", [sid]);
          }
          return `/series/${sid}`;
        }
        throw new Error("not found");
      };
      act().then(redirect).catch((e: unknown) =>
        send(400, { error: e instanceof Error ? e.message : String(e) }));
      return;
    }

    send(404, { error: "not found" });
  }).listen(port, () => console.log(`kupoyomi listening on :${port}`));
}
