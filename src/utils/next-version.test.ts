import { isNextVersionAtLeast } from "./next-version";

describe("isNextVersionAtLeast", () => {
  it("compares major, minor and patch", () => {
    expect(isNextVersionAtLeast("16.3.8", [16, 3, 8])).toBe(true);
    expect(isNextVersionAtLeast("16.3.7", [16, 3, 8])).toBe(false);
    expect(isNextVersionAtLeast("16.4.0", [16, 3, 8])).toBe(true);
    expect(isNextVersionAtLeast("16.2.9", [16, 3, 0])).toBe(false);
    expect(isNextVersionAtLeast("17.0.0", [16, 3, 8])).toBe(true);
    expect(isNextVersionAtLeast("15.9.9", [16, 3, 8])).toBe(false);
  });

  it("counts a prerelease as its release", () => {
    expect(isNextVersionAtLeast("16.4.0-canary.2", [16, 3, 8])).toBe(true);
    expect(isNextVersionAtLeast("16.3.8-canary.0", [16, 3, 8])).toBe(true);
  });

  it("is undefined for a version that does not parse", () => {
    expect(isNextVersionAtLeast(undefined, [16, 3, 8])).toBeUndefined();
    expect(isNextVersionAtLeast("latest", [16, 3, 8])).toBeUndefined();
  });
});
