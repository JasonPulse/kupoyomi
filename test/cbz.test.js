import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { buildCbz, comicInfo } from "../src/cbz.js";
import { listEntries, pageEntries, readEntry } from "../src/unzip.js";
/**
 * The writer and the reader are a matched pair and nothing else validates them: a
 * truncated or misread archive looks like a working file until someone opens a chapter.
 */
const scratch = () => mkdtempSync(join(tmpdir(), "cbz-"));
test("an archive we write reads back byte for byte", async () => {
    const pages = [
        { name: "001.jpg", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]) },
        { name: "002.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]) },
    ];
    const cbz = buildCbz([
        { name: "ComicInfo.xml", data: comicInfo({ series: "Test & Co", number: "12.5", pageCount: 2 }) },
        ...pages,
    ], new Date("2026-05-10T00:00:00Z"));
    const dir = scratch();
    const path = join(dir, "ch.cbz");
    writeFileSync(path, cbz);
    const entries = await listEntries(path);
    assert.equal(entries.length, 3, "three entries written");
    const imgs = pageEntries(entries);
    assert.deepEqual(imgs.map((e) => e.name), ["001.jpg", "002.png"], "ComicInfo.xml is not a page");
    for (const [i, entry] of imgs.entries()) {
        const got = await readEntry(path, entry);
        assert.deepEqual(got, pages[i].data, `page ${i} round-trips`);
    }
    const meta = entries.find((e) => e.name === "ComicInfo.xml");
    const xml = (await readEntry(path, meta)).toString("utf8");
    assert.match(xml, /<Series>Test &amp; Co<\/Series>/, "xml is escaped");
    // A date carries no time, so local getters used to render 2026-05-10 as the 9th.
    assert.match(xml, /<Year>2026<\/Year><Month>5<\/Month><Day>10<\/Day>/);
});
test("deflated entries are inflated, since adopted files are not ours", async () => {
    // Suwayomi's archives are not necessarily stored, so the reader must handle method 8.
    const payload = Buffer.from("x".repeat(500) + "not really an image");
    const deflated = deflateRawSync(payload);
    const name = Buffer.from("001.jpg");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    name.copy(central, 46);
    const cdOffset = local.length + deflated.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(cdOffset, 16);
    const path = join(scratch(), "deflated.cbz");
    writeFileSync(path, Buffer.concat([local, deflated, central, end]));
    const entries = await listEntries(path);
    assert.equal(entries[0].method, 8);
    assert.deepEqual(await readEntry(path, entries[0]), payload);
});
test("pages sort numerically, not lexically", () => {
    const fake = ["010.jpg", "9.jpg", "100.jpg", "cover.txt"].map((name) => ({
        name, method: 0, size: 10, csize: 10, offset: 0,
    }));
    assert.deepEqual(pageEntries(fake).map((e) => e.name), ["9.jpg", "010.jpg", "100.jpg"]);
});
//# sourceMappingURL=cbz.test.js.map