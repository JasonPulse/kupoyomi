import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "paperback-ext", "bundles");

const TYPES: Record<string, string> = {
  ".json": "application/json", ".js": "application/javascript",
  ".png": "image/png", ".html": "text/html; charset=utf-8",
};

/**
 * Serves the extension bundle as a Paperback repository.
 *
 * Paperback installs a source by being given a base URL containing versioning.json, so
 * the whole directory is served verbatim. Read from disk per request rather than cached:
 * the files change only on deploy, and a stale cache after an extension update is worse
 * than a file read.
 */
export function serveBundle(relPath: string): { body: Buffer; type: string } | null {
  const rel = normalize(relPath.replace(/^\/+/, "")).replace(/^(\.\.[/\\])+/, "");
  const target = rel === "" ? join(root, "index.html") : join(root, rel);
  // Anything resolving outside the bundle directory is refused outright.
  if (!target.startsWith(root)) return null;
  if (!existsSync(target)) return null;
  if (statSync(target).isDirectory()) {
    const idx = join(target, "index.html");
    if (!existsSync(idx)) return null;
    return { body: readFileSync(idx), type: TYPES[".html"]! };
  }
  const ext = target.slice(target.lastIndexOf("."));
  return { body: readFileSync(target), type: TYPES[ext] ?? "application/octet-stream" };
}

export const bundleExists = (): boolean => existsSync(join(root, "versioning.json"));

export const bundleFiles = (): string[] =>
  bundleExists() ? readdirSync(root, { recursive: true }).map(String) : [];
