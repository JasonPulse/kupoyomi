import { writeFileSync, mkdirSync, renameSync } from "node:fs";
import { config } from "./config.js";
import { db } from "./db.js";
import { gql } from "./suwayomi.js";
import { resolveManga } from "./match.js";

const httpBase = (): string => config.suwayomiUrl.replace(/\/api\/graphql\/?$/, "");

/**
 * Pulls the synopsis and cover for a series from its bound source.
 *
 * The cover is written into the series folder as cover.jpg, which is what Komga, Kavita
 * and anything else look for. That is the whole of komf's job in this stack, so owning it
 * here is what lets komf go.
 */
export async function refreshMetadata(seriesId: number): Promise<{ cover: boolean; description: boolean }> {
  const p = db();
  const s = (await p.query<{ title: string; folder: string }>(
    "SELECT title, folder FROM series WHERE id = $1", [seriesId])).rows[0];
  if (!s) throw new Error(`no series ${seriesId}`);
  const b = (await p.query<{ source_id: string; source_url: string | null }>(
    "SELECT source_id, source_url FROM series_binding WHERE series_id = $1 AND role = 'primary'",
    [seriesId])).rows[0];
  if (!b?.source_url) return { cover: false, description: false };

  const mangaId = await resolveManga(b.source_id, s.title, b.source_url);
  await gql(`mutation($id:Int!){ fetchMangaAndChapters(input:{id:$id,fetchChapters:false,fetchManga:true}){ clientMutationId } }`,
    { id: mangaId }).catch(() => undefined);
  const d = (await gql<{ manga: { description: string | null; status: string; thumbnailUrl: string | null } }>(
    `{ manga(id:${mangaId}) { description status thumbnailUrl } }`)).manga;

  let coverPath: string | null = null;
  if (d.thumbnailUrl) {
    try {
      const r = await fetch(`${httpBase()}${d.thumbnailUrl}`);
      if (r.ok) {
        const dir = `${config.libraryRoot}/${s.folder}`;
        mkdirSync(dir, { recursive: true });
        // Written then renamed, so a reader scanning mid-download never sees a partial
        // image and cache it.
        const tmp = `${dir}/.cover.part`;
        writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
        renameSync(tmp, `${dir}/cover.jpg`);
        coverPath = `${dir}/cover.jpg`;
      }
    } catch { /* a missing cover is not worth failing the refresh over */ }
  }

  await p.query(
    `UPDATE series SET description = COALESCE($2, description),
       cover_path = COALESCE($3, cover_path),
       status = CASE WHEN $4 <> 'UNKNOWN' THEN $4 ELSE status END,
       metadata_at = now() WHERE id = $1`,
    [seriesId, d.description, coverPath, d.status]);
  return { cover: coverPath !== null, description: !!d.description };
}
