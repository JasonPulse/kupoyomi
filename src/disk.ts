import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { config, legacyRootIsLocal } from "./config.js";

const run = promisify(execFile);

export type DiskSeries = {
  /** null for a local/flat series folder that sits directly under the root. */
  sourceDir: string | null;
  folder: string;
  cbzCount: number;
  /** Actual .cbz basenames present. The ledger is validated against these rather
   *  than trusting Suwayomi's isDownloaded flag, which drifts from reality. */
  files: string[];
};

type Node = { files: string[]; kids: Map<string, string[]> };

/**
 * Series folders contain '[', ']' and '*'. Shell globs and `find -path` read those
 * as metacharacters, which is how a folder named "..._[Oppai_Kyousei]_..." got
 * mistaken for a source directory. Everything here walks a flat listing instead.
 */
async function listingLocal(): Promise<Array<[string, number, string]>> {
  const out: Array<[string, number, string]> = [];
  for (const d1 of await readdir(config.legacyRoot, { withFileTypes: true })) {
    out.push([d1.isDirectory() ? "d" : "f", 1, d1.name]);
    if (!d1.isDirectory()) continue;
    for (const d2 of await readdir(join(config.legacyRoot, d1.name), { withFileTypes: true })) {
      out.push([d2.isDirectory() ? "d" : "f", 2, `${d1.name}/${d2.name}`]);
      if (!d2.isDirectory()) continue;
      for (const d3 of await readdir(join(config.legacyRoot, d1.name, d2.name), { withFileTypes: true })) {
        if (d3.isFile()) out.push(["f", 3, `${d1.name}/${d2.name}/${d3.name}`]);
      }
    }
  }
  return out;
}

async function listingRemote(): Promise<Array<[string, number, string]>> {
  const { context, namespace, selector, container, remoteRoot } = config.kubectl;
  try {
    await run("kubectl", ["version", "--client=true", "-o", "json"]);
  } catch {
    throw new Error(
      `LEGACY_ROOT '${config.legacyRoot}' is not a directory and kubectl is unavailable. ` +
      `In the cluster, mount the manga share; on a workstation, install kubectl or set LEGACY_ROOT.`,
    );
  }
  const { stdout: pod } = await run("kubectl", [
    "--context", context, "-n", namespace, "get", "pod", "-l", selector,
    "-o", "jsonpath={.items[0].metadata.name}",
  ]);
  const { stdout } = await run(
    "kubectl",
    ["--context", context, "-n", namespace, "exec", pod.trim(), "-c", container, "--",
     "sh", "-c", `cd '${remoteRoot}' && find . -mindepth 1 -maxdepth 3 -printf '%y|%d|%p\\n' 2>/dev/null`],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  const out: Array<[string, number, string]> = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const first = line.indexOf("|");
    const second = line.indexOf("|", first + 1);
    if (first < 0 || second < 0) continue;
    out.push([line.slice(0, first), Number(line.slice(first + 1, second)), line.slice(second + 1 + 2)]);
  }
  return out;
}

export async function scanLegacyTree(): Promise<DiskSeries[]> {
  const listing = legacyRootIsLocal() ? await listingLocal() : await listingRemote();
  const tree = new Map<string, Node>();
  const node = (name: string): Node => {
    let n = tree.get(name);
    if (!n) { n = { files: [], kids: new Map() }; tree.set(name, n); }
    return n;
  };

  for (const [kind, depth, path] of listing) {
    const parts = path.split("/");
    const top = parts[0];
    if (!top) continue;
    if (depth === 1) node(top);
    else if (depth === 2) {
      const n = node(top);
      if (kind === "f") { if (path.endsWith(".cbz") && parts[1]) n.files.push(parts[1]); }
      else if (parts[1]) n.kids.set(parts[1], n.kids.get(parts[1]) ?? []);
    } else if (depth === 3 && kind === "f" && parts[1] && parts[2]) {
      const n = node(top);
      if (path.endsWith(".cbz")) (n.kids.get(parts[1]) ?? n.kids.set(parts[1], []).get(parts[1])!).push(parts[2]);
    }
  }

  const out: DiskSeries[] = [];
  for (const [top, info] of tree) {
    // A source folder holds series folders that hold the chapters; a local series
    // folder holds its chapters directly.
    if (info.kids.size > 0 && info.files.length === 0) {
      for (const [series, files] of info.kids) {
        out.push({ sourceDir: top, folder: series, cbzCount: files.length, files });
      }
    } else {
      out.push({ sourceDir: null, folder: top, cbzCount: info.files.length, files: info.files });
    }
  }
  return out;
}
