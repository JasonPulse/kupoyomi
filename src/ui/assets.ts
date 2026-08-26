import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
    ["/ui-well.png", "ui-well.png", "image/png"],
    ["/ui-input.png", "ui-input.png", "image/png"],
    ["/ui-btn.png", "ui-btn.png", "image/png"],
    ["/ui-btn-press.png", "ui-btn-press.png", "image/png"],
    ["/ui-select.png", "ui-select.png", "image/png"],
    ["/ui-select-arrow.png", "ui-select-arrow.png", "image/png"],
    ["/ui-tab-active.png", "ui-tab-active.png", "image/png"],
    ["/ui-header.png", "ui-header.png", "image/png"],
    ["/ui-bg.png", "ui-bg.png", "image/png"],
    // GUI Pro FantasyRPG. The ornate frame and the dark button, both from its own set.
    // The frame ships white with alpha so its colour is ours to choose; it is tinted to a
    // muted bronze rather than the pack's fantasy gold, which is the cartoonish part.
    // The frame is a stack, not one image: fill, inner glow, inner line, outer frame with
    // its corner work, and a bottom accent. Using only the frame is what made it flat.
    ["/ui2-corner.png", "ui2-corner.png", "image/png"],
    ["/ui2-glow.png", "ui2-glow.png", "image/png"],
    ["/ui2-inner.png", "ui2-inner.png", "image/png"],
    ["/ui2-bottom.png", "ui2-bottom.png", "image/png"],
    ["/ui2-divider.png", "ui2-divider.png", "image/png"],
    ["/ui2-btn.png", "ui2-btn.png", "image/png"],
  ] as const).flatMap(([route, file, type]) => {
    const body = load(file);
    return body ? [[route, { body, type }] as const] : [];
  }),
);


/**
 * A content hash per asset, appended to its url in the stylesheet.
 *
 * Assets are served with a day of cache, so replacing one leaves every browser showing
 * the old file until tomorrow. That is why a button already changed on the server was
 * still green on screen, and it is the same mistake the cover images had: the file
 * changed and the url did not, so nothing went and fetched it.
 */
export const ASSET_VERSION: Record<string, string> = Object.fromEntries(
  Object.entries(ASSETS).map(([route, a]) => [
    route, a ? createHash("sha1").update(a.body).digest("hex").slice(0, 8) : "0",
  ]),
);

/** "/ui-btn.png" -> "/ui-btn.png?v=1a2b3c4d". Use this everywhere a stylesheet or a
 *  template names an asset, or the next replacement is invisible again. */
export const asset = (route: string): string =>
  `${route}${ASSET_VERSION[route] ? `?v=${ASSET_VERSION[route]}` : ""}`;
