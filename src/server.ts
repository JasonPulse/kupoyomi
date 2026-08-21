import { createServer } from "node:http";
import { db } from "./db.js";
import { installedExtensions, installExtension, serverAbout, fetchExtensionIndex } from "./suwayomi.js";

/**
 * Suwayomi runs on emptyDir, so on every cold start it comes up with no extensions
 * at all. Replaying the declared set is what makes that survivable without anyone
 * logging into a UI and guessing which extensions they used last time.
 */
export async function reconcileExtensions(): Promise<{ available: number; installed: number; missing: string[] }> {
  // Prime the repo index first: a cold Suwayomi knows about no extensions at all,
  // and an install issued against an empty index fails on an unknown package.
  const available = await fetchExtensionIndex();
  const desired = (await db().query<{ pkg_name: string }>(
    "SELECT pkg_name FROM extension WHERE desired ORDER BY pkg_name")).rows.map((r) => r.pkg_name);
  const present = new Set((await installedExtensions()).map((e) => e.pkgName));
  const missing = desired.filter((p) => !present.has(p));

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
  return { available, installed: missing.length - failed.length, missing: failed };
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
  };
};

export async function serve(): Promise<void> {
  const port = Number(process.env["PORT"] ?? 8080);

  try {
    const about = await serverAbout();
    const r = await reconcileExtensions();
    console.log(`suwayomi ${about.version} (${about.revision}); ${r.available} extensions available, installed ${r.installed}` +
      (r.missing.length > 0 ? `; ${r.missing.length} unavailable upstream` : ""));
  } catch (err) {
    // Never block startup on Suwayomi: it may still be booting its JVM, and the
    // health endpoint has to answer so the probe can tell the difference.
    console.error(`suwayomi not ready at boot: ${err instanceof Error ? err.message : String(err)}`);
  }

  createServer((req, res) => {
    const url = req.url ?? "/";
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url === "/healthz") return send(200, { ok: true });
    if (url === "/api/stats") {
      stats().then((s) => send(200, s)).catch((e: unknown) =>
        send(503, { error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    send(404, { error: "not found" });
  }).listen(port, () => console.log(`kupoyomi listening on :${port}`));
}
