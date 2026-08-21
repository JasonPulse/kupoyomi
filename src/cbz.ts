import { crc32 } from "node:zlib";

/**
 * Minimal CBZ writer: a zip using STORE (no compression) and nothing else.
 *
 * A dependency would be dead weight here. Pages are already JPEG or WebP, so
 * deflating them buys nothing and costs CPU, and STORE means the whole format is
 * three fixed-layout records. Node 22 provides zlib.crc32, which is the only
 * genuinely fiddly part.
 */
type Entry = { name: string; data: Buffer };

// UTC throughout. An upload date carries no time, so reading it back with local
// getters shifts the day: 2026-05-10 rendered as the 9th in PDT.
const dosTime = (d: Date): { time: number; date: number } => ({
  time: ((d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1)) & 0xffff,
  date: (((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate()) & 0xffff,
});

export function buildCbz(entries: Entry[], modified: Date): Buffer {
  const { time, date } = dosTime(modified);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const sum = crc32(e.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);   // local file header signature
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(e.data.length, 18);   // compressed size == uncompressed
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    name.copy(local, 30);
    locals.push(local, e.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk number start
    central.writeUInt16LE(0, 36);         // internal attributes
    central.writeUInt32LE(0, 38);         // external attributes
    central.writeUInt32LE(offset, 42);    // offset of local header
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + e.data.length;
  }

  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);               // comment length

  return Buffer.concat([...locals, cd, end]);
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * ComicInfo.xml, so metadata travels inside the file. That is what makes the library
 * readable by Komga, Kavita or anything else if this project is ever abandoned, and it
 * is why covers no longer depend on a server guessing from the first page.
 */
export function comicInfo(v: {
  series: string; number: string; title?: string | null; scanlator?: string | null;
  uploaded?: Date | null; pageCount: number; summary?: string | null;
}): Buffer {
  const d = v.uploaded;
  const parts = [
    `<Series>${xmlEscape(v.series)}</Series>`,
    `<Number>${xmlEscape(v.number)}</Number>`,
    v.title ? `<Title>${xmlEscape(v.title)}</Title>` : "",
    v.scanlator ? `<Translator>${xmlEscape(v.scanlator)}</Translator>` : "",
    d ? `<Year>${d.getUTCFullYear()}</Year><Month>${d.getUTCMonth() + 1}</Month><Day>${d.getUTCDate()}</Day>` : "",
    `<PageCount>${v.pageCount}</PageCount>`,
    v.summary ? `<Summary>${xmlEscape(v.summary)}</Summary>` : "",
  ].filter(Boolean).join("\n  ");
  return Buffer.from(
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  ${parts}\n</ComicInfo>\n`,
    "utf8");
}
