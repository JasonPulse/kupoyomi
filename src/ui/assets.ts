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
    ["/favicon-32.png", "favicon-32.png", "image/png"],
    ["/favicon-16.png", "favicon-16.png", "image/png"],
    ["/icon-192.png", "icon-192.png", "image/png"],
    ["/icon-512.png", "icon-512.png", "image/png"],
    ["/apple-touch-icon.png", "apple-touch-icon.png", "image/png"],
    // RPG and MMO UI 4. Nine-slice frames, button states and the tab indicator.
    ["/ui-panel.png", "ui-panel.png", "image/png"],
    ["/ui-well.png", "ui-well.png", "image/png"],
    ["/ui-input.png", "ui-input.png", "image/png"],
    ["/ui-btn.png", "ui-btn.png", "image/png"],
    ["/ui-btn-hover.png", "ui-btn-hover.png", "image/png"],
    ["/ui-btn-danger.png", "ui-btn-danger.png", "image/png"],
    ["/ui-btn-danger-hover.png", "ui-btn-danger-hover.png", "image/png"],
    ["/ui-tab-active.png", "ui-tab-active.png", "image/png"],
    ["/ui-header.png", "ui-header.png", "image/png"],
  ] as const).flatMap(([route, file, type]) => {
    const body = load(file);
    return body ? [[route, { body, type }] as const] : [];
  }),
);
