import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleZip, loadBlockmap, planDelta } from "./self-updater-core";

// Fixture rules: no binary files in git. Every test builds its own bytes.
// A blockmap describes a file as chunks. Each chunk has a checksum and a size.
// This test uses a tiny chunk size, so the fixtures stay small.

const sha512 = (data: Buffer): string =>
  createHash("sha512").update(data).digest("base64");

// Build an electron-builder style gzip JSON blockmap for one file.
// `chunks` lists the chunk bytes in file order. The checksum is the
// sha512 of each chunk. Only equal chunks must match, so any hash works.
function buildBlockmap(chunks: Buffer[]): Buffer {
  const map = {
    version: "2",
    files: [
      {
        name: "app.zip",
        offset: 0,
        checksums: chunks.map((c) => sha512(c)),
        sizes: chunks.map((c) => c.byteLength),
      },
    ],
  };
  return gzipSync(Buffer.from(JSON.stringify(map), "utf8"));
}

// Split bytes into chunks of the given sizes, in order.
function split(data: Buffer, sizes: number[]): Buffer[] {
  const out: Buffer[] = [];
  let pos = 0;
  for (const size of sizes) {
    out.push(data.subarray(pos, pos + size));
    pos += size;
  }
  if (pos !== data.byteLength) throw new Error("fixture sizes do not match");
  return out;
}

const chunk = (letter: string, size: number): Buffer =>
  Buffer.alloc(size, letter);

const joinBytes = (...parts: Buffer[]): Buffer => Buffer.concat(parts);

describe("self-updater delta core", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "openstyle-delta-test-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Write an old file and return its path and blockmap.
  function writeOld(name: string, data: Buffer, sizes: number[]) {
    const path = join(dir, name);
    writeFileSync(path, data);
    return { path, map: buildBlockmap(split(data, sizes)) };
  }

  // Serve byte ranges of the new file, like a range GET would.
  function rangeServer(newData: Buffer) {
    const calls: [number, number][] = [];
    const fetchRange = async (start: number, endInclusive: number) => {
      calls.push([start, endInclusive]);
      return newData.subarray(start, endInclusive + 1);
    };
    return { calls, fetchRange };
  }

  it("loadBlockmap reads a gzip blockmap from a Buffer and from a path", async () => {
    const data = joinBytes(chunk("A", 8), chunk("B", 4));
    const gz = buildBlockmap(split(data, [8, 4]));

    const fromBuffer = await loadBlockmap(gz);
    const path = join(dir, "bm-load.blockmap");
    writeFileSync(path, gz);
    const fromPath = await loadBlockmap(path);

    const expected = [
      { offset: 0, size: 8, checksum: sha512(chunk("A", 8)) },
      { offset: 8, size: 4, checksum: sha512(chunk("B", 4)) },
    ];
    expect(fromBuffer).toEqual(expected);
    expect(fromPath).toEqual(expected);
  });

  it("identical files need no fetch and the output equals the new file", async () => {
    const sizes = [8, 8, 8, 4];
    const data = joinBytes(
      chunk("A", 8),
      chunk("B", 8),
      chunk("C", 8),
      chunk("D", 4),
    );
    const old = writeOld("identical-old.zip", data, sizes);
    const newMap = await loadBlockmap(buildBlockmap(split(data, sizes)));

    const plan = planDelta(await loadBlockmap(old.map), newMap);
    expect(plan.bytesToFetch).toBe(0);
    expect(plan.bytesTotal).toBe(data.byteLength);
    expect(plan.ops.every((op) => op.type === "copy")).toBe(true);

    const server = rangeServer(data);
    const dest = join(dir, "identical-out.zip");
    const result = await assembleZip(old.path, plan, server.fetchRange, dest);

    expect(server.calls).toHaveLength(0);
    expect(result.bytesFetched).toBe(0);
    expect(readFileSync(dest).equals(data)).toBe(true);
    expect(result.sha512).toBe(sha512(data));
  });

  it("disjoint files fetch every byte in one range", async () => {
    const oldData = joinBytes(chunk("a", 8), chunk("b", 8), chunk("c", 8));
    const newData = joinBytes(chunk("X", 8), chunk("Y", 8), chunk("Z", 8));
    const old = writeOld("disjoint-old.zip", oldData, [8, 8, 8]);
    const newMap = await loadBlockmap(buildBlockmap(split(newData, [8, 8, 8])));

    const plan = planDelta(await loadBlockmap(old.map), newMap);
    expect(plan.bytesToFetch).toBe(newData.byteLength);
    expect(plan.bytesTotal).toBe(newData.byteLength);

    const server = rangeServer(newData);
    const dest = join(dir, "disjoint-out.zip");
    const result = await assembleZip(old.path, plan, server.fetchRange, dest);

    expect(server.calls).toEqual([[0, newData.byteLength - 1]]);
    expect(result.bytesFetched).toBe(newData.byteLength);
    expect(readFileSync(dest).equals(newData)).toBe(true);
    expect(result.sha512).toBe(sha512(newData));
  });

  it("partial overlap builds the right plan and the output matches the new file", async () => {
    // Old: A B C D (8 bytes each).
    // New: A X Y C E, where E is a 4 byte chunk.
    // A and C exist in the old file. X, Y and E do not.
    const oldData = joinBytes(
      chunk("A", 8),
      chunk("B", 8),
      chunk("C", 8),
      chunk("D", 8),
    );
    const newSizes = [8, 8, 8, 8, 4];
    const newData = joinBytes(
      chunk("A", 8),
      chunk("X", 8),
      chunk("Y", 8),
      chunk("C", 8),
      chunk("E", 4),
    );
    const old = writeOld("overlap-old.zip", oldData, [8, 8, 8, 8]);
    const newMap = await loadBlockmap(buildBlockmap(split(newData, newSizes)));

    const plan = planDelta(await loadBlockmap(old.map), newMap);
    expect(plan.bytesTotal).toBe(36);
    expect(plan.bytesToFetch).toBe(20);
    expect(plan.ops).toEqual([
      { type: "copy", oldOffset: 0, size: 8 },
      { type: "fetch", newOffset: 8, size: 16 },
      { type: "copy", oldOffset: 16, size: 8 },
      { type: "fetch", newOffset: 32, size: 4 },
    ]);

    const server = rangeServer(newData);
    const dest = join(dir, "overlap-out.zip");
    const result = await assembleZip(old.path, plan, server.fetchRange, dest);

    expect(result.bytesFetched).toBe(20);
    expect(readFileSync(dest).equals(newData)).toBe(true);
    expect(result.sha512).toBe(sha512(newData));
  });

  it("adjacent fetch chunks become one range request", async () => {
    // Old: A only. New: A X Y Z. X, Y and Z are one fetch run.
    const oldData = chunk("A", 8);
    const newData = joinBytes(
      chunk("A", 8),
      chunk("X", 8),
      chunk("Y", 8),
      chunk("Z", 8),
    );
    const old = writeOld("merge-old.zip", oldData, [8]);
    const newMap = await loadBlockmap(
      buildBlockmap(split(newData, [8, 8, 8, 8])),
    );

    const plan = planDelta(await loadBlockmap(old.map), newMap);
    expect(plan.ops).toEqual([
      { type: "copy", oldOffset: 0, size: 8 },
      { type: "fetch", newOffset: 8, size: 24 },
    ]);

    const server = rangeServer(newData);
    const dest = join(dir, "merge-out.zip");
    const result = await assembleZip(old.path, plan, server.fetchRange, dest);

    expect(server.calls).toEqual([[8, 31]]);
    expect(server.calls).toHaveLength(1);
    expect(result.bytesFetched).toBe(24);
    expect(readFileSync(dest).equals(newData)).toBe(true);
  });

  it("a wrong fetched range gives a different sha512, so the caller can fall back", async () => {
    const oldData = joinBytes(
      chunk("A", 8),
      chunk("B", 8),
      chunk("C", 8),
      chunk("D", 8),
    );
    const newData = joinBytes(
      chunk("A", 8),
      chunk("X", 8),
      chunk("Y", 8),
      chunk("C", 8),
      chunk("E", 4),
    );
    const old = writeOld("corrupt-old.zip", oldData, [8, 8, 8, 8]);
    const newMap = await loadBlockmap(
      buildBlockmap(split(newData, [8, 8, 8, 8, 4])),
    );
    const plan = planDelta(await loadBlockmap(old.map), newMap);

    // The server returns the right length, but one byte is wrong.
    const badFetch = async (start: number, endInclusive: number) => {
      const bytes = Buffer.from(newData.subarray(start, endInclusive + 1));
      bytes[0] ^= 0xff;
      return bytes;
    };
    const dest = join(dir, "corrupt-out.zip");
    const result = await assembleZip(old.path, plan, badFetch, dest);

    expect(result.sha512).not.toBe(sha512(newData));
    expect(readFileSync(dest).equals(newData)).toBe(false);
  });
});
