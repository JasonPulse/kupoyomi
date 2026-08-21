import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets");

/** Icons are small and never change at runtime, so they are read once at startup. */
const load = (name: string): Buffer | null => {
  try { return readFileSync(join(dir, name)); } catch { return null; }
};

export const ASSETS: Record<string, { body: Buffer; type: string } | undefined> = Object.fromEntries(
  ([
    ["/favicon.ico", "favicon.ico", "image/x-icon"],
    ["/icon-192.png", "icon-192.png", "image/png"],
    ["/icon-512.png", "icon-512.png", "image/png"],
    ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"],
    ["/newstop.png", "newstop.png", "image/png"],
    ["/newsmiddle.png", "newsmiddle.png", "image/png"],
    ["/newsbottom.png", "newsbottom.png", "image/png"],
    ["/newsheader.png", "newsheader.png", "image/png"],
    ["/arrows.png", "arrows.png", "image/png"],
    ["/tab-on.png", "tab-on.png", "image/png"],
  ] as const).flatMap(([route, file, type]) => {
    const body = load(file);
    return body ? [[route, { body, type }] as const] : [];
  }),
);
