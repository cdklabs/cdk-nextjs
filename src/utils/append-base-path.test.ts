import { appendBasePath } from "./append-base-path";

describe("appendBasePath", () => {
  const origin = "https://d111111abcdef8.cloudfront.net";

  it("returns the origin unchanged when there's no basePath", () => {
    expect(appendBasePath(origin)).toBe(origin);
    expect(appendBasePath(origin, "")).toBe(origin);
    expect(appendBasePath(origin, "/")).toBe(origin);
  });

  it("appends the basePath without doubling slashes", () => {
    expect(appendBasePath(origin, "/base")).toBe(`${origin}/base`);
    expect(appendBasePath(origin, "base")).toBe(`${origin}/base`);
    expect(appendBasePath(origin, "/base/")).toBe(`${origin}/base`);
    expect(appendBasePath(origin, "/team/app")).toBe(`${origin}/team/app`);
  });
});
