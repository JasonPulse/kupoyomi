import { report } from "./report.js";
import { findHomes, compare } from "./match.js";
import { migrate, stageCandidates, closeDb } from "./db.js";
import { snapshot } from "./snapshot.js";
import { seedLedger } from "./seed.js";
import { listCandidates, confirmCandidate } from "./confirm.js";
import { remap } from "./remap.js";
import { archiveCandidate } from "./archive.js";
import { backfillUrls } from "./backfill.js";
import { relayout } from "./relayout.js";
import { prune } from "./prune.js";
import { probe } from "./probe.js";
import { parseCheck } from "./parsecheck.js";
import { serve } from "./server.js";

const usage = `kupoyomi <command>

  report                     what is on disk vs what the library tracks
  find [--only S] [--limit N]  exact-title search for series stranded on dead sources
  compare <mangaId>          chapter count, gaps and recent uploads for one candidate
  migrate                    apply db/*.sql (needs DATABASE_URL)
  import [--limit N]         find homes and stage them for confirmation
  snapshot                   freeze the old Suwayomi's state before it is torn down
  seed                       build the ledger from the snapshot
  candidates [--id N]        what needs a decision, with the numbers to decide on
  confirm <id> --pick <mangaId>  bind a stranded series to the source you chose
  remap <seriesId> [--dry-run]   adopt stranded files into the confirmed binding
  archive <id> [--dry-run]   file a finished series: adopt its files, bind no source
  relayout [seriesId] [--dry-run] move chapters into the canonical tree
  prune [--dry-run]          drop ledger rows whose file is gone
  probe [--batch N] [--max M] install extensions in batches to find unhoused series
  parse-check                how well chapter numbers can be read from filenames
  serve                      http api + extension bootstrap (long running)

report, find and compare are read-only.
`;

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const main = async (): Promise<void> => {
  switch (process.argv[2]) {
    case "report":
      await report();
      break;
    case "find": {
      const only = flag("only");
      const limit = flag("limit");
      const { resolved, review } = await findHomes({
        ...(only !== undefined ? { only } : {}),
        ...(limit !== undefined ? { limit: Number(limit) } : {}),
      });
      console.log(`\nexact match found: ${resolved.length}   needs review: ${review.length}`);
      for (const s of resolved) {
        console.log(`\n${s.title}`);
        console.log(`   ${s.files} files stranded under ${s.deadSource} (title from db: ${s.exactTitleKnown})`);
        for (const c of s.candidates) console.log(`   -> ${c.sourceName.padEnd(22)} manga=${c.mangaId} via=${c.matched}`);
      }
      for (const s of review) console.log(`\nREVIEW  ${s.files} files  ${s.title}`);
      break;
    }
    case "compare": {
      const id = Number(process.argv[3]);
      if (!Number.isInteger(id)) throw new Error("compare needs a manga id");
      const c = await compare(id);
      console.log(`${c.source.padEnd(20)} chapters=${String(c.chapters).padStart(4)}  ` +
        `range=${c.range ? `${c.range[0]}-${c.range[1]}` : "-"}  missing=${c.missing.length} ` +
        `${JSON.stringify(c.missing.slice(0, 8))}`);
      for (const l of c.latest) console.log(`     ch ${String(l.chapter).padStart(7)}  ${l.uploaded}  ${l.scanlator ?? "-"}`);
      break;
    }
    case "candidates": {
      const id = flag("id");
      await listCandidates(id !== undefined ? { id: Number(id) } : {});
      await closeDb();
      break;
    }
    case "confirm": {
      const id = Number(process.argv[3]);
      const pick = Number(flag("pick"));
      if (!Number.isInteger(id) || !Number.isInteger(pick)) throw new Error("usage: confirm <id> --pick <mangaId>");
      await confirmCandidate(id, pick);
      await closeDb();
      break;
    }
    case "archive": {
      const cid = Number(process.argv[3]);
      if (!Number.isInteger(cid)) throw new Error("usage: archive <candidateId> [--dry-run]");
      await archiveCandidate(cid, { dryRun: process.argv.includes("--dry-run") });
      await closeDb();
      break;
    }
    case "remap": {
      const sid = Number(process.argv[3]);
      if (!Number.isInteger(sid)) throw new Error("usage: remap <seriesId> [--dry-run]");
      await remap(sid, { dryRun: process.argv.includes("--dry-run") });
      await closeDb();
      break;
    }
    case "parse-check":
      await parseCheck();
      break;
    case "probe": {
      const b = flag("batch"), m = flag("max");
      await probe({
        ...(b !== undefined ? { batch: Number(b) } : {}),
        ...(m !== undefined ? { max: Number(m) } : {}),
      });
      await closeDb();
      break;
    }
    case "prune":
      await prune({ dryRun: process.argv.includes("--dry-run") });
      await closeDb();
      break;
    case "relayout": {
      const sid = Number(process.argv[3]);
      await relayout({
        ...(Number.isInteger(sid) ? { seriesId: sid } : {}),
        dryRun: process.argv.includes("--dry-run"),
      });
      await closeDb();
      break;
    }
    case "backfill-urls":
      await backfillUrls();
      await closeDb();
      break;
    case "seed":
      await seedLedger();
      await closeDb();
      break;
    case "snapshot":
      await snapshot();
      await closeDb();
      break;
    case "serve":
      await serve();
      return;                 // long running: never close the pool
    case "migrate":
      await migrate();
      await closeDb();
      break;
    case "import": {
      const lim = flag("limit");
      const { resolved, review } = await findHomes(lim !== undefined ? { limit: Number(lim) } : {});
      const n = await stageCandidates(resolved, review);
      console.log(`\nstaged ${n} candidates: ${resolved.length} exact, ${review.length} needing review`);
      await closeDb();
      break;
    }
    default:
      process.stdout.write(usage);
      process.exitCode = process.argv[2] === undefined ? 0 : 1;
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
