import { buildInventory } from "./inventory.js";

const pct = (n: number, of: number): number => (of === 0 ? 0 : Math.floor((n * 100) / of));

export async function report(): Promise<void> {
  const inv = await buildInventory();

  console.log(`series folders on disk        ${inv.folders}  (${inv.distinct} distinct titles)`);
  console.log(`tracked in suwayomi library  ${inv.tracked}`);
  console.log(`NOT tracked                  ${inv.untracked}`);
  console.log(`duplicated across folders    ${inv.duplicated.length}`);
  console.log(`duplicate-numbered chapters  ${inv.duplicateChapters.total} across ${inv.duplicateChapters.series} series\n`);

  console.log(`${"source folder".padEnd(30)} ${"series".padStart(6)} ${"cbz".padStart(6)}  status`);
  for (const s of inv.bySource) {
    console.log(
      `${s.sourceDir.slice(0, 30).padEnd(30)} ${String(s.series).padStart(6)} ` +
      `${String(s.files).padStart(6)}  ${s.live ? "ok" : "NO INSTALLED SOURCE"}`,
    );
  }
  console.log(
    `\nstranded on dead sources: ${inv.strandedSeries} series, ${inv.strandedFiles} files ` +
    `(${pct(inv.strandedFiles, inv.sourceFiles)}% of ${inv.sourceFiles})`,
  );

  console.log(`\ngap chapters the bound source already lists (re-queue) : ${inv.gaps.requeue}`);
  console.log(`gap chapters needing a supplemental source            : ${inv.gaps.elsewhere}`);

  if (inv.duplicated.length > 0) {
    console.log("\nduplicated series (candidates for consolidation):");
    for (const { key, copies } of inv.duplicated.sort(
      (a, b) => Math.max(...b.copies.map((c) => c.cbzCount)) - Math.max(...a.copies.map((c) => c.cbzCount)),
    )) {
      console.log(`  ${key.slice(0, 50)}`);
      for (const c of [...copies].sort((a, b) => b.cbzCount - a.cbzCount)) {
        console.log(`      ${String(c.cbzCount).padStart(5)} cbz  ${c.sourceDir ?? "(local folder)"}`);
      }
    }
  }
}
