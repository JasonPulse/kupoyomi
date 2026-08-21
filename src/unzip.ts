import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

/**
 * Minimal zip reader, enough to serve pages out of a CBZ.
 *
 * Reads the central directory rather than scanning, so listing a 40-page chapter costs
 * two small reads instead of pulling the whole archive off the share. Handles STORE and
 * DEFLATE: chapters this app wrote are stored, but the 3500 adopted from Suwayomi are
 * whatever it produced.
 */
export type Entry = { name: string; method: number; size: number; csize: number; offset: number };

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

export async function listEntries(path: string): Promise<Entry[]> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    // The end-of-central-directory record is last, but a trailing comment can push it
    // back, so search the final 64KB.
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");

    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);

    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);

    const out: Entry[] = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CD_SIG) break;
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      out.push({ name, method, size: usize, csize, offset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/** Image entries in reading order, ignoring metadata and directory records. */
export const pageEntries = (entries: Entry[]): Entry[] =>
  entries
    .filter((e) => /\.(jpe?g|png|webp|gif|avif|bmp)$/i.test(e.name) && e.size > 0)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

export async function readEntry(path: string, entry: Entry): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    // The local header repeats the name and may carry a different extra field length,
    // so its own lengths decide where the data starts.
    const head = Buffer.alloc(30);
    await fh.read(head, 0, 30, entry.offset);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataAt = entry.offset + 30 + nameLen + extraLen;

    const raw = Buffer.alloc(entry.csize);
    await fh.read(raw, 0, entry.csize, dataAt);
    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
  } finally {
    await fh.close();
  }
}
