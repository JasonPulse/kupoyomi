/**
 * Recovers a chapter number from a Suwayomi-era filename.
 *
 * Needed only where there is no snapshot row to map files to numbers -- manual
 * downloads, and series whose Suwayomi record never existed. Everywhere else the
 * snapshot is authoritative and this is not used, because filenames are a worse
 * source of truth than a database.
 *
 * Real examples from the library:
 *   Chap 1.cbz                                   -> 1
 *   Chapter 125_ Season 3 [Start].cbz            -> 125
 *   Ch.001.cbz                                   -> 1
 *   chapter 10.cbz                               -> 10
 *   Psylocke Scans_Vol.1 Ch.1 - Knight.cbz       -> 1      (chapter, not volume)
 *   Raptor Scans_Vol.4 Ch.70 - The Knight.cbz    -> 70
 *   [0006]_Chapter_5.5.cbz                       -> 5.5
 */
const PATTERNS: RegExp[] = [
  // An explicit chapter marker wins, so "Vol.4 Ch.70" yields 70 rather than 4.
  // Note the leading class rather than \b: underscore is a word character, so \b
  // never fires in "[0001]_Chapter_1" and that whole naming style failed to parse.
  /(?:^|[\s._\-\[\]])ch(?:ap(?:ter)?)?[\s._-]*(\d+(?:\.\d+)?)/i,
  // Manhwa sources number in episodes: "Official_Episode 12.cbz"
  /(?:^|[\s._\-\[\]])ep(?:isode)?[\s._-]*(\d+(?:\.\d+)?)/i,
  // Our own canonical naming: "Title - c0070 [Group].cbz"
  /(?:^|[\s._\-])c(\d{3,4}(?:\.\d+)?)(?:$|[\s._\-\[])/,
];

export function parseChapterNumber(filename: string): number | null {
  const stem = filename.replace(/\.cbz$/i, "");
  for (const re of PATTERNS) {
    const m = re.exec(stem);
    if (m?.[1]) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  // Last resort: a bare trailing number, e.g. "[0006]_5.5". Deliberately last so a
  // volume or a bracketed index never wins over a real chapter marker.
  const bare = /(\d+(?:\.\d+)?)\s*$/.exec(stem);
  if (bare?.[1]) {
    const n = Number(bare[1]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
