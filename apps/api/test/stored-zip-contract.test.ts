import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";

import yauzl from "yauzl";

const u16 = (value: number): Buffer => {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
};

const u32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};

const writeStoredZip = (entries: Array<{ name: string; data: Buffer; compress: "raw" | "zlib" | "store" }>): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const nameData = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const compressed = entry.compress === "raw"
      ? deflateRawSync(entry.data)
      : entry.compress === "zlib"
        ? deflateSync(entry.data)
        : entry.data;
    const method = entry.compress === "store" ? 0 : 8;
    const storedData = compressed.length > 0 && compressed.length < entry.data.length
      ? compressed
      : entry.data;
    const storedMethod = storedData === entry.data ? 0 : method;
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      u16(20),
      u16(0),
      u16(storedMethod),
      u16(0),
      u16(0),
      u32(crc),
      u32(storedData.length),
      u32(entry.data.length),
      u16(nameData.length),
      u16(0),
      nameData,
      storedData
    ]);
    const central = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      u16(20),
      u16(20),
      u16(0),
      u16(storedMethod),
      u16(0),
      u16(0),
      u32(crc),
      u32(storedData.length),
      u32(entry.data.length),
      u16(nameData.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(localOffset),
      nameData
    ]);
    locals.push(local);
    centrals.push(central);
    localOffset += local.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralBytes.length),
    u32(localOffset),
    u16(0)
  ]);
  return Buffer.concat([...locals, centralBytes, end]);
};

const extract = (path: string): Promise<Map<string, Buffer>> =>
  new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, decodeStrings: false }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("failed to open zip"));
        return;
      }
      const files = new Map<string, Buffer>();
      zip.readEntry();
      zip.on("entry", (entry) => {
        const name = Buffer.from(entry.fileName).toString("utf8");
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            reject(streamError ?? new Error(`failed to read ${name}`));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("error", reject);
          stream.on("end", () => {
            files.set(name, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => resolve(files));
      zip.on("error", reject);
    });
  });

test("yauzl extracts ZIP method 8 written as raw deflate", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-stored-zip-"));
  const path = join(root, "health.zip");
  try {
    const payload = Buffer.from("<?xml version=\"1.0\"?><HealthData locale=\"zh_CN\"></HealthData>\n".repeat(40));
    writeFileSync(path, writeStoredZip([{ name: "export.xml", data: payload, compress: "raw" }]));
    const files = await extract(path);
    assert.equal(files.get("export.xml")?.equals(payload), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("yauzl rejects ZIP method 8 written as zlib-wrapped deflate", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-stored-zip-zlib-"));
  const path = join(root, "health.zip");
  try {
    const payload = Buffer.from("<?xml version=\"1.0\"?><HealthData locale=\"zh_CN\"></HealthData>\n".repeat(40));
    const archive = writeStoredZip([{ name: "export.xml", data: payload, compress: "zlib" }]);
    assert.equal(archive[8], 8, "method 8 must be used so the zlib-wrapper mismatch is exercised");
    writeFileSync(path, archive);
    await assert.rejects(() => extract(path));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("yauzl extracts ZIP method 0 store fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "rai-stored-zip-store-"));
  const path = join(root, "health.zip");
  try {
    const payload = Buffer.from("already-small");
    writeFileSync(path, writeStoredZip([{ name: "export.xml", data: payload, compress: "store" }]));
    const files = await extract(path);
    assert.equal(files.get("export.xml")?.equals(payload), true);
    assert.equal(readFileSync(path)[8], 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
