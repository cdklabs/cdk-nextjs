/* eslint-disable import/no-extraneous-dependencies */
import { CachedRouteKind } from "next/dist/server/response-cache/index.js";
import appPlayground from "./__fixtures__/app-playground.json";
import pagesI18n from "./__fixtures__/pages-i18n.json";
import { cacheKindResolver } from "./cache-kinds";
import { groupPrerenders } from "./cache-utils";

type Prerender = { pathname: string; parentOutputId: string };

const prerender = (pathname: string, parentOutputId: string): Prerender => ({
  pathname,
  parentOutputId,
});

describe("cacheKindResolver", () => {
  it.each([
    ["app-playground", appPlayground],
    ["pages-i18n", pagesI18n],
  ])("gives every prerendered route in %s a kind", (_, fixture) => {
    const kindOf = cacheKindResolver(fixture.outputs);
    const groups = groupPrerenders(fixture.outputs.prerenders as Prerender[]);
    const unkinded = [...groups]
      .filter(([, variants]) => kindOf(variants) === undefined)
      .map(([route]) => route);
    expect(unkinded).toEqual([]);
  });

  it("seeds catch-all and optional catch-all prerenders", () => {
    const kindOf = cacheKindResolver({
      pages: [{ id: "/docs/[...slug]" }],
      appPages: [{ id: "/shop/[[...rest]]" }],
      appRoutes: [],
    });
    const groups = groupPrerenders([
      prerender("/docs/a/b", "/docs/[...slug]"),
      prerender("/shop", "/shop/[[...rest]]"),
      prerender("/shop/x/y/z", "/shop/[[...rest]]"),
      prerender("/shop/x/y/z.rsc", "/shop/[[...rest]]"),
    ]);
    expect(kindOf(groups.get("/docs/a/b")!)).toBe(CachedRouteKind.PAGES);
    expect(kindOf(groups.get("/shop")!)).toBe(CachedRouteKind.APP_PAGE);
    expect(kindOf(groups.get("/shop/x/y/z")!)).toBe(CachedRouteKind.APP_PAGE);
  });

  it("seeds a Pages Router SSG home page, which its output reports as /index", () => {
    const kindOf = cacheKindResolver({
      pages: [{ id: "/index" }],
      appPages: [],
      appRoutes: [],
    });
    const groups = groupPrerenders([
      prerender("/", "/index"),
      prerender("/_next/data/b/index.json", "/index"),
    ]);
    expect([...groups.keys()]).toEqual(["/"]);
    expect(kindOf(groups.get("/")!)).toBe(CachedRouteKind.PAGES);
  });

  it("takes the kind from the owning output, not from a template the path also matches", () => {
    const kindOf = cacheKindResolver({
      pages: [],
      appPages: [{ id: "/about" }],
      appRoutes: [{ id: "/[slug]" }],
    });
    const groups = groupPrerenders([
      prerender("/about", "/about"),
      prerender("/feed", "/[slug]"),
    ]);
    expect(kindOf(groups.get("/about")!)).toBe(CachedRouteKind.APP_PAGE);
    expect(kindOf(groups.get("/feed")!)).toBe(CachedRouteKind.APP_ROUTE);
  });
});
