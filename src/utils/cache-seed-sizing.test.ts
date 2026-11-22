import {
  cacheSeedSizing,
  MAX_EPHEMERAL_STORAGE_MIB,
  storageStep,
} from "./cache-seed-sizing";

const MIB = 1024 ** 2;

describe("storageStep", () => {
  it("never goes below the 512 MiB default", () => {
    expect(storageStep(1, MAX_EPHEMERAL_STORAGE_MIB)).toBe(512);
    expect(storageStep(512, MAX_EPHEMERAL_STORAGE_MIB)).toBe(512);
  });

  it("doubles past each step", () => {
    expect(storageStep(513, MAX_EPHEMERAL_STORAGE_MIB)).toBe(1024);
    expect(storageStep(1025, MAX_EPHEMERAL_STORAGE_MIB)).toBe(2048);
  });

  it("caps at max", () => {
    expect(storageStep(8193, MAX_EPHEMERAL_STORAGE_MIB)).toBe(10240);
  });
});

describe("cacheSeedSizing", () => {
  const storage = (bytes: number) => cacheSeedSizing(bytes).ephemeralStorageMib;

  it("rounds the cache up to the MiB", () => {
    expect(cacheSeedSizing(0).cacheMib).toBe(0);
    expect(cacheSeedSizing(1).cacheMib).toBe(1);
    expect(cacheSeedSizing(MIB + 1).cacheMib).toBe(2);
  });

  // The budget, the cache plus 128 MiB, crosses each step at these cache
  // sizes: 384 MiB is a 512 MiB budget exactly, and one byte more rounds up.
  it.each([
    [384, 512, 1024],
    [896, 1024, 2048],
    [1920, 2048, 4096],
    [3968, 4096, 8192],
    [8064, 8192, 10240],
  ])(
    "steps up just past a %i MiB cache (%i MiB -> %i MiB)",
    (mib, at, over) => {
      expect(storage((mib - 1) * MIB)).toBe(at);
      expect(storage(mib * MIB)).toBe(at);
      expect(storage(mib * MIB + 1)).toBe(over);
    },
  );

  it("caps at 10 GiB, and flags only a cache past it", () => {
    // 10112 MiB + 128 is exactly 10240.
    expect(cacheSeedSizing(10112 * MIB)).toMatchObject({
      ephemeralStorageMib: 10240,
      exceedsMax: false,
    });
    expect(cacheSeedSizing(10112 * MIB + 1)).toMatchObject({
      ephemeralStorageMib: 10240,
      exceedsMax: true,
    });
  });

  it("raises memory to 1024 MB only past 256 MiB of cache", () => {
    expect(cacheSeedSizing(0).memoryMb).toBe(512);
    expect(cacheSeedSizing(256 * MIB).memoryMb).toBe(512);
    expect(cacheSeedSizing(256 * MIB + 1).memoryMb).toBe(1024);
  });
});
