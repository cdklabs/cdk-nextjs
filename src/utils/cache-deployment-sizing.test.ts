import {
  deploymentLambdaSizing,
  MAX_EPHEMERAL_STORAGE_MIB,
  storageStep,
} from "./cache-deployment-sizing";

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

describe("deploymentLambdaSizing", () => {
  const storage = (bytes: number) =>
    deploymentLambdaSizing(bytes).ephemeralStorageMib;

  it("budgets twice the cache plus 128 MiB, rounded up to the MiB", () => {
    expect(deploymentLambdaSizing(0).cacheMib).toBe(0);
    expect(deploymentLambdaSizing(1).cacheMib).toBe(1);
    expect(deploymentLambdaSizing(MIB + 1).cacheMib).toBe(2);
  });

  // `wanted` = 2 × MiB + 128 crosses each step at these cache sizes: 192 MiB
  // is a 512 MiB budget exactly, and one byte more rounds up to 193 MiB.
  it.each([
    [192, 512, 1024],
    [448, 1024, 2048],
    [960, 2048, 4096],
    [1984, 4096, 8192],
    [4032, 8192, 10240],
  ])(
    "steps up just past a %i MiB cache (%i MiB -> %i MiB)",
    (mib, at, over) => {
      expect(storage((mib - 1) * MIB)).toBe(at);
      expect(storage(mib * MIB)).toBe(at);
      expect(storage(mib * MIB + 1)).toBe(over);
    },
  );

  it("caps at 10 GiB, and flags only a cache past it", () => {
    // 5056 MiB × 2 + 128 is exactly 10240.
    expect(deploymentLambdaSizing(5056 * MIB)).toMatchObject({
      ephemeralStorageMib: 10240,
      exceedsMax: false,
    });
    expect(deploymentLambdaSizing(5056 * MIB + 1)).toMatchObject({
      ephemeralStorageMib: 10240,
      exceedsMax: true,
    });
    expect(deploymentLambdaSizing(50000 * MIB)).toMatchObject({
      ephemeralStorageMib: 10240,
      exceedsMax: true,
    });
  });

  it("raises memory to 1024 MB only past 256 MiB of cache", () => {
    expect(deploymentLambdaSizing(0).memoryLimit).toBeUndefined();
    expect(deploymentLambdaSizing(256 * MIB).memoryLimit).toBeUndefined();
    expect(deploymentLambdaSizing(256 * MIB + 1).memoryLimit).toBe(1024);
  });
});
