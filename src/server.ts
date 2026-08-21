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
import { extensionsPage, setExtension } from "./ui/extensions.js";
import { ASSETS } from "./ui/assets.js";
import { refreshMetadata } from "./metadata.js";
import { createReadStream } from "node:fs";
import { scanWanted } from "./fetch.js";
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
  if (process.env["SCHEDULER"] !== "off") startScheduler();
  else console.log("scheduler: disabled by SCHEDULER=off");
  serverAbout().then((a) => console.log(`suwayomi ${a.version} (${a.revision})`)).catch(() => {});

  const readBody = (req: import("node:http").IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
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

    if (req.method === "GET") {
      if (path === "/") return html(libraryPage(url.searchParams.get("q") ?? undefined));
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
        const meta = /^\/series\/(\d+)\/metadata$/.exec(path);
        if (meta) { await refreshMetadata(Number(meta[1])); return `/series/${meta[1]}`; }
        const mute = /^\/series\/(\d+)\/mute$/.exec(path);
        if (mute) {
          await db().query("UPDATE series SET muted = NOT muted WHERE id = $1", [Number(mute[1])]);
          return `/series/${mute[1]}`;
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
