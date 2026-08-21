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

/** True when the share is mounted locally, false when we have to go via kubectl. */
export const legacyRootIsLocal = (): boolean => existsSync(config.legacyRoot);
