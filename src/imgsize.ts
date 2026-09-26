/**
 * What kind of image this is, from its first bytes, or null if it is not one.
 *
 * A source answered a thumbnail request with ninety-four bytes of "403 Forbidden" HTML
 * under a 200, and those bytes were written out as cover.jpg and served as the artwork.
 * A status code says the request arrived, not that the answer is a picture.
 *
 * Every format the library actually stores is listed, which matters: imageSize below
 * reads only JPEG and PNG, and using it as the test would have rejected the WebP covers
 * several series already have.
 */
export function imageType(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  // ISO base media: AVIF and HEIC both announce themselves in the ftyp brand.
  if (buf.toString("ascii", 4, 8) === "ftyp"
    && /avif|avis|heic|heix|mif1/.test(buf.toString("ascii", 8, 12))) return "image/avif";
  return null;
}

export const isImage = (buf: Buffer): boolean => imageType(buf) !== null;

/**
 * Pixel dimensions of an image, read from its header without decoding it.
 *
 * Exists because "page one" is not always a usable cover. A webtoon chapter is a single
 * strip, and one of those is 720 by 15560: scaled into a tile it is a vertical hairline.
 * Knowing the shape is what lets a cover be chosen rather than assumed.
 *
 * JPEG and PNG only. Anything else returns null, and the caller falls back to page order.
 */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) { p++; continue; }             // resync on a corrupt stream
      const marker = buf[p + 1]!;
      // Standalone markers carry no length field, so they are stepped over, not read.
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { p += 2; continue; }
      const len = buf.readUInt16BE(p + 2);
      // SOF0 through SOF15, skipping the DHT/JPG/DAC markers that share the range.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
      }
      if (len < 2) return null;
      p += 2 + len;
    }
  }
  return null;
}

/**
 * How wrong a shape is for a cover. A comic page is around 1.4 tall for its width and a
 * book cover is similar, so that is the target; a strip scores far away from it and loses.
 */
export const coverScore = (size: { width: number; height: number } | null): number =>
  size === null || size.width === 0 ? 99 : Math.abs(size.height / size.width - 1.4);
