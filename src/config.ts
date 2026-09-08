import { existsSync } from "node:fs";

/**
 * In-cluster defaults. Running from a workstation, point SUWAYOMI_URL at the
 * ingress and leave the roots unset: the download tree is then read over
 * `kubectl exec`, which is how this gets verified before it is ever deployed.
 */
export const config = {
  suwayomiUrl: process.env["SUWAYOMI_URL"] ?? "http://suwayomi-service/api/graphql",
  databaseUrl: process.env["DATABASE_URL"] ?? "",

  /** Suwayomi's legacy per-source download tree. Read-only; only the importer cares. */
  legacyRoot: process.env["LEGACY_ROOT"] ?? "/data/Manga",
  /** Our canonical tree: {Series}/{Series} - c0070 [Group].cbz */
  libraryRoot: process.env["LIBRARY_ROOT"] ?? "/data/Library",

  kubectl: {
    context: process.env["KUBE_CONTEXT"] ?? "pulse-clift",
    namespace: process.env["KUBE_NAMESPACE"] ?? "homelab",
    selector: process.env["KUBE_SELECTOR"] ?? "app=komga",
    container: process.env["KUBE_CONTAINER"] ?? "suwayomi",
    remoteRoot:
      process.env["KUBE_REMOTE_ROOT"] ??
      "/home/suwayomi/.local/share/Tachidesk/downloads/mangas",
  },
} as const;

/**
 * How many attempts a chapter gets before it stops being retried on the normal schedule.
 *
 * Written out five times over: the fetcher, the queue page, the downloads page, the stats
 * endpoint, and the library page, where it was still a hardcoded 4 after the limit moved
 * to 6. So the library called chapters dead that the fetcher fully intended to retry.
 */
export const maxAttempts = (): number =>
  Math.max(1, Number(process.env["FETCH_MAX_ATTEMPTS"] ?? 6));

/**
 * Suwayomi's HTTP root, for page images and thumbnails that are not GraphQL.
 *
 * The same replace() lived in fetch.ts, metadata.ts and server.ts, one of them reading
 * the environment directly rather than the parsed config.
 */
export const suwayomiHttpBase = (): string =>
  config.suwayomiUrl.replace(/\/api\/graphql\/?$/, "");

/** True when the share is mounted locally, false when we have to go via kubectl. */
export const legacyRootIsLocal = (): boolean => existsSync(config.legacyRoot);
