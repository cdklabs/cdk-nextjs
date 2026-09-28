import { caseCanonicalPath } from "./case-redirect";
import type { AdapterManifest } from "./manifest";

type Config = Pick<AdapterManifest, "config">;

const plain = { config: { basePath: "", i18n: null } } as unknown as Config;

describe("caseCanonicalPath", () => {
  it("respells static segments and keeps dynamic values", () => {
    expect(
      caseCanonicalPath("/API/reports/1", "/api/reports/[id]", plain),
    ).toBe("/api/reports/1");
    expect(
      caseCanonicalPath("/API/Reports/AbC", "/api/reports/[id]", plain),
    ).toBe("/api/reports/AbC");
  });

  it("is undefined when nothing would change", () => {
    expect(
      caseCanonicalPath("/api/reports/1", "/api/reports/[id]", plain),
    ).toBeUndefined();
  });

  // A rewrite onto the route, or any other shape the template doesn't have.
  it("is undefined when the path is not the template's shape", () => {
    expect(
      caseCanonicalPath("/feed/1", "/api/reports/[id]", plain),
    ).toBeUndefined();
    expect(
      caseCanonicalPath("/API/reports/1/2", "/api/reports/[id]", plain),
    ).toBeUndefined();
  });

  it("gives a catch-all everything left", () => {
    expect(caseCanonicalPath("/DOCS/A/b", "/docs/[...slug]", plain)).toBe(
      "/docs/A/b",
    );
    expect(caseCanonicalPath("/DOCS", "/docs/[[...slug]]", plain)).toBe(
      "/docs",
    );
  });

  // What dispatch actually hands over: `resolvedPathname` is a manifest key,
  // which carries the basePath.
  it("matches basePath-prefixed templates, keeping the canonical basePath", () => {
    const manifest = {
      config: { basePath: "/prod", i18n: null },
    } as unknown as Config;
    expect(
      caseCanonicalPath(
        "/prod/API/reports/1",
        "/prod/api/reports/[id]",
        manifest,
      ),
    ).toBe("/prod/api/reports/1");
    expect(
      caseCanonicalPath(
        "/PROD/API/reports/1/",
        "/prod/api/reports/[id]",
        manifest,
      ),
    ).toBe("/prod/api/reports/1/");
  });
});
