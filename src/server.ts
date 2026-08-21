import { createServer } from "node:http";
import { db } from "./db.js";
import { installedExtensions, installExtension, serverAbout, fetchExtensionIndex } from "./suwayomi.js";
import { reviewPage, handleConfirmPost } from "./web.js";

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
    last_reconcile: lastReconcile,
  };
};

export async function serve(): Promise<void> {
  const port = Number(process.env["PORT"] ?? 8080);

  // Deliberately not awaited: the health endpoint has to come up regardless of
  // whether Suwayomi is answering yet, or the probe cannot tell "still booting"
  // from "broken".
  void bootstrapLoop();
  serverAbout().then((a) => console.log(`suwayomi ${a.version} (${a.revision})`)).catch(() => {});

  createServer((req, res) => {
    const url = req.url ?? "/";
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url === "/healthz") return send(200, { ok: true });
    if (url === "/" && req.method === "GET") {
      reviewPage().then((html) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
      }).catch((e: unknown) => send(500, { error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    if (url === "/confirm" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        handleConfirmPost(body).then((to) => {
          res.writeHead(303, { location: to });
          res.end();
        }).catch((e: unknown) => send(400, { error: e instanceof Error ? e.message : String(e) }));
      });
      return;
    }
    if (url === "/api/stats") {
      stats().then((s) => send(200, s)).catch((e: unknown) =>
        send(503, { error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    send(404, { error: "not found" });
  }).listen(port, () => console.log(`kupoyomi listening on :${port}`));
}
