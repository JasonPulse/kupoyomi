import { scanLegacyTree } from "./disk.js";
import { parseChapterNumber } from "./chapternum.js";

/** Measures how far filename parsing gets before it is trusted for anything. */
export async function parseCheck(): Promise<void> {
  const disk = await scanLegacyTree();
  let total = 0, parsed = 0, collided = 0;
  const failures: string[] = [];
  const worst: Array<[string, number, number]> = [];

  for (const d of disk) {
    if (d.files.length === 0) continue;
    const nums = new Map<number, number>();
    let ok = 0;
    for (const f of d.files) {
      total++;
      const n = parseChapterNumber(f);
      if (n === null) { if (failures.length < 10) failures.push(`${d.sourceDir ?? "(local)"}/${d.folder}/${f}`); continue; }
      parsed++; ok++;
      nums.set(n, (nums.get(n) ?? 0) + 1);
    }
    const dupes = [...nums.values()].filter((v) => v > 1).length;
    collided += dupes;
    if (dupes > 0) worst.push([`${d.sourceDir ?? "(local)"}/${d.folder}`, dupes, d.files.length]);
  }

  console.log(`cbz files on disk        ${total}`);
  console.log(`chapter number recovered ${parsed}  (${Math.round((parsed / total) * 100)}%)`);
  console.log(`unparseable              ${total - parsed}`);
  console.log(`numbers hit by 2+ files  ${collided}  (one file per number is required)`);
  if (failures.length > 0) { console.log("\nsample failures:"); for (const f of failures) console.log(`   ${f}`); }
  if (worst.length > 0) {
    console.log("\nfolders with colliding numbers:");
    for (const [name, d, n] of worst.sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`   ${d} of ${n}  ${name}`);
  }
}
