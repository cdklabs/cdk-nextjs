# Next.js private APIs

The first [design principle](../README.md#design-principles) of cdk-nextjs is to integrate through Next.js's official interfaces, meaning the [Deployment Adapter API](https://nextjs.org/docs/app/guides/deployment-adapters) and [`@next/routing`](https://www.npmjs.com/package/@next/routing), and not through Next.js internals. This page lists every place cdk-nextjs still depends on something Next.js doesn't document, why, and what would let us remove it. It is the code that breaks first on a Next.js upgrade, which is why `next` and `@next/routing` are exact-pinned and bumped together.

Keep it short and current:

- Use a public interface wherever one exists.
- A PR that adds a private dependency adds it here and says why. A PR that removes one deletes its entry.

Written against Next.js **16.4.0**.

## What is public

These look internal but are documented, so they are **not** tracked below:

- `onBuildComplete` and every `ctx` field we read (`outputs`, `routing`, `buildId`, `projectDir`, `repoRoot`, `distDir`, and so on), plus `modifyConfig`
- `adapterPath` / `NEXT_ADAPTER_PATH`
- Calling an entrypoint as `handler(req, res, { waitUntil, requestMeta })`, along with `requestMeta.hostname`, `.revalidate` and `.render404` ([invoking entrypoints](https://nextjs.org/docs/app/api-reference/adapters/invoking-entrypoints))
- `resolveRoutes`, `responseToMiddlewareResult`, `detectLocale`, `detectDomainLocale` and `normalizeLocalePath` from `@next/routing`
- The `cacheHandler`, `cacheHandlers` and `images.customCacheHandler` config options. The `'use cache'` handler types (`CacheHandler`, `CacheEntry`) come from `next/cache`. The incremental `cacheHandler`'s types have no public export yet (see §5).
- `x-nextjs-cache`, `.next/static` + `public/` (self-hosting docs), `NEXT_TELEMETRY_DISABLED`

## 1. Runtime `require`s of `next/dist/*`

These break if Next.js moves or renames a file, even in a patch release.

- **Image optimization rebuilt from internals.** `src/runtime/image.ts` and `image-utils.ts` replay `next start`'s `handleNextImageRequest` step by step. They use:
  - `ImageOptimizerCache`, `imageOptimizer`, `fetchExternalImage`, `sendResponse` and `ImageError` from `server/image-optimizer.js`
  - `ResponseCache` from `server/response-cache`, with an internal options bag. Its constructor signature changed in 16.3.8, and we tell the two versions apart by matching an error message.
  - The undocumented constructor args of the app's `cacheHandler` (`_requestHeaders`, `revalidatedTags`, …)

  This is our largest private dependency. _Upstream:_ an image optimizer entrypoint in adapter outputs, or an exported request handler.

- **`serveStatic` / `getContentType` / `getExtension`** (`server/serve-static.js`). Serves `public/`, `_next/static` and prerendered HTML with the same `send` behavior `next start` has (`src/runtime/static-files.ts`). _Upstream:_ a public static-serving helper.
- **`setup-node-env.external.js`** (`build/adapter/setup-node-env.external.js`). Must run before any entrypoint loads, or app-page renders throw `FakeAsyncLocalStorage` invariant errors (`src/runtime/next-modules.ts`). Its source comment says it is meant for adapters, but the docs don't mention it. _Upstream:_ document it, or have every entrypoint require it itself, as `templates/middleware.js` does.
- **`ensureInstrumentationRegistered`** (`server/lib/router-utils/instrumentation-globals.external.js`). Runs `instrumentation.register()` before entrypoints, as `next start` does. _Upstream:_ an instrumentation entrypoint in adapter outputs.
- **`next/dist/compiled/@vercel/nft`**. At build time we trace the modules listed above ourselves, because no app trace includes them (`src/adapter/build-outputs.ts`). This goes away when those modules go away.
- **`@next/env`, resolved through `next`'s dependency tree**. Loads `.env` files at runtime. We also copy the `.env` / `.env.production` files the way `writeStandaloneDirectory` does. _Upstream:_ include env files in adapter outputs.
- **`route-cache-key.js` existence probe** (`src/adapter/init-cache.ts`). Detects whether this Next.js scopes cache keys by source route (16.3.8+). _Upstream:_ `cacheKey` on `outputs.prerenders[]`.

## 2. Reading or writing Next.js in-process state

- **Changing `tagsManifest`**. We find `server/lib/incremental-cache/tags-manifest.external.js` by scanning `require.cache`, then set `stale` on entries in its `Map` (`src/adapter/s3-cache-handler.ts`). The `cacheHandler` API can't express "stale" for `revalidateTag(tag, profile)`: `lastModified: -1` only means expired. If the module isn't found, we fall back to expiring. _Upstream:_ a stale signal in `CacheHandler.get`'s return value, or a public `markTagsStale` hook. This is the top ask.
- **`requestMeta` fields beyond the documented ones**: `query`, `params` and `initURL` (`src/runtime/core.ts`). Without them, `RouteModule.prepare` re-runs rewrites over the resolved query, mis-decodes `%2F` captures, or builds URLs against `localhost`. _Upstream:_ document these fields.
- **`process.chdir` in place of `requestMeta.relativeProjectDir`**. `__NEXT_RELATIVE_PROJECT_DIR` is inlined at build time, and `app-page-runtime` ignores the `requestMeta` override, so `cwd` is the only thing that works for every entrypoint type. _Upstream:_ honor `relativeProjectDir` in every runtime.
- **`RevalidateConfig` / `router-server-context` type**, re-declared in `core.ts` because it isn't in the published types.

## 3. Internal formats and conventions

There are no imports here. We depend on the shape of strings, files and objects.

**Cache entries**

- **Seeding the response cache** (`src/adapter/init-cache.ts`). Writes the internal shapes `APP_PAGE{html, rscData, segmentData, headers, postponed, status}`, `APP_ROUTE` and `PAGES` so a new deploy starts warm. Buffers and Maps are serialized by hand (`cache-utils.ts`). _Upstream:_ a public prerender-to-cache-entry helper, or a stable serialized format.
- **Recovering the cache key from the prerender file path** (`<distDir>/server/route-cache/<KIND>/<sha256(route)>/…`), plus the pre-16.3.8 key rules. _Upstream:_ `cacheKey` on `outputs.prerenders[]`.
- **`x-next-cache-tags` header** read from cache values. It's the only place a page's or route's tags exist, because the response-cache `set` ctx carries none. _Upstream:_ `tags` in the `set` ctx and on `outputs.prerenders[]`.
- **`_N_T_` implicit tag prefix and the `/layout` / `/page` suffixes**. Turned back into CloudFront invalidation paths. _Upstream:_ pass the path and type to `revalidateTag`.
- **Filtering `x-nextjs-prerender` and `x-nextjs-postponed` out of `fallback.initialHeaders`** before they go into a cache entry. _Upstream:_ say which headers belong in a cache entry.
- **Prerender pathname conventions**: `.rsc`, `.segments/<name>.segment.rsc`, `/index.rsc`, `/_next/data/<buildId>/<page>.json`, and the Pages Router home page reported as `/index`. _Upstream:_ `variantOf` / `segmentPath` fields on outputs.
- **Fetch-cache keys are ≥32 hex characters**, which is how we skip CloudFront invalidation for them, and `kind` is compared as the string `"FETCH"`. _Upstream:_ pass `kind` on `set` / `revalidateTag`.
- **`required-server-files.json`**. The cache handler reads `basePath` from it, and finds the file through the undocumented `CacheHandlerContext.serverDistDir`. _Upstream:_ `basePath` on `CacheHandlerContext`.
- **`process.env.NEXT_PHASE`**, used to tell build from runtime inside the cache handler. _Upstream:_ `phase` on `CacheHandlerContext`.

**`cacheHandler` / `cacheHandlers` behavior we rely on.** None of these is in the docs.

- Returning `lastModified: -1` forces a blocking re-render, while `null` serves the PPR shell. `set(key, null)` means delete.
- A `cacheControl` stored on an entry overrides `SharedCacheControls` (16.4).
- `retainPreviousCacheEntry` writes back the same object `get` returned, so we compare by identity.
- A Pages Router `notFound` is a `null` value that is never written to disk.
- `cacheComponents` builds read their own writes back across two passes.
- `'use cache'`: `revalidate: -1` means stale, `getExpiration() === Infinity` passes the implicit tags, and `expire === 0` means a dynamic entry.
- Marker timestamps use the same clock as `CacheEntry.timestamp` (`performance.timeOrigin + now()`).
- Since 16.4, staged renders end their static stage on `Date.now`, `Math.random` or `crypto` calls, so all handler I/O runs outside the request context.

**Routing and request protocol**

- **`nxtP` query params**. We repair `@next/routing`'s `$nxtPid` prefix substitution and optional catch-all `undefined` keys, and we pass `%2F` captures out-of-band. Otherwise `prepare` double-decodes them, which is a path-traversal 500 (`src/runtime/dispatch.ts`). _Upstream:_ fix the substitution in `@next/routing`, and document a contract for passing params.
- **App Router request headers in the CloudFront cache key**: `rsc`, `next-url`, `next-router-state-tree`, `next-router-prefetch`, `next-router-segment-prefetch` and `x-prerender-revalidate` (`src/nextjs-distribution.ts`). CloudFront can't key on `Vary`, so this list is hardcoded. _Upstream:_ include the vary-by request header set in adapter outputs.
- **`_rsc` query param**, covered by `?*` / `path*` invalidation wildcards.
- **Interception route markers** (`(.)`, `(..)`, `(..)(..)`, `(...)`). These are re-implemented so function groups can follow interception rewrites, which happen on the `RSC` and `Next-Url` headers that CloudFront can't route on (`src/adapter/function-groups.ts`). _Upstream:_ interception metadata in adapter outputs.
- **`.body` static files**. The content type is inferred from the suffix, because `STATIC_FILE` outputs don't carry headers. _Upstream:_ a content type on static outputs.
- **Turbopack entrypoints can be async modules**, so we await the module before reading `handler`.
- **Node middleware entrypoint contract**. It's documented only in the deprecated Edge section (`templates/middleware.ts`).
- **Fields on `NodeNextRequest` / `NodeNextResponse`** that our `IncomingMessage` / `ServerResponse` shims must provide (`req.url` reassignment, `fetchMetrics`, `res.flush()` per chunk, …).

**Build output layout**

- **Client chunk names** (`main-app-*` for webpack, `turbopack-*.js` for Turbopack). `NextjsGlobalFunctions` prepends `patch-fetch.js` to these, to add `x-amz-content-sha256` to same-origin POST/PUT so OAC-signed Function URLs accept the body (`src/nextjs-build/nextjs-build.ts`). The patch itself only touches web globals. The private part is _where_ it's injected. _Upstream:_ an adapter hook for adding a client entry script.
- **`<distDir>/server/pages/` and `<distDir>/static/` layout**, used to classify static files. _Upstream:_ a `kind` or router field on `staticFiles`.
- **Build ID is pinned under `deploymentId`**. When `deploymentId` / `NEXT_DEPLOYMENT_ID` is set, `buildId` is a constant, so we derive our own `buildId-deploymentId`. _Upstream:_ document this.
- **`sharp` resolved through `next`'s package.json**, so the staged Lambda binaries match the copy the optimizer loads. Goes away with an image optimizer output.
- **`next build` must run from `projectDir`**, because `relative(cwd, projectDir)` is inlined into entrypoints.

## 4. `next start` behavior copied by hand

We copy these because `@next/routing` or the entrypoints leave them to the host. They don't break loudly. They drift silently.

- Internal request header filtering (`x-middleware-*`, `x-matched-path`, `x-nextjs-data`, `next-resume`, …). This matters for security: `next-resume` would otherwise let a client inject PPR postponed state. Also re-adding `x-nextjs-data: 1` for `/_next/data` requests. _Upstream:_ `resolveRoutes` filters them and flags data requests.
- Repeated-slash 308 (`normalizeRepeatedSlashes`), both at runtime and in a CloudFront Function, because OAC signs the raw path.
- `@next/routing` gaps: `trailingSlash` variants, the i18n root, redirect-location normalization, `headers()` and `requestHeaders` dropped when middleware responds, and `x-middleware-rewrite` echoed back in response headers.
- Error page ladder (`_not-found` → `/404` → `/500` → `/_error`) and forced statuses. _Upstream:_ document what the adapter is responsible for on errors.
- Header lists `FORBIDDEN_HEADERS`, `ipcForbiddenHeaders` and `NON_HTML_SEC_FETCH_DESTS`, and the helpers `removePathPrefix`, `formatDynamicImportPath` and `extractEtag`.
- Static-file 405 and the `send` 400/412/416 mapping. The accept/throw rule from `NextServer#revalidate`.
- Pages Router `/index` → `/` (minimal-mode `x-matched-path` rewrite).

## 5. Type-only imports

These are erased at compile time, so they never fail at runtime. A rename still breaks our build.

- `CacheHandler`, `CacheHandlerValue` and `CacheHandlerContext` (`server/lib/incremental-cache`), `IncrementalCacheValue` (`server/response-cache`), `CacheControl` (`server/lib/cache-control`). _Upstream:_ public type exports.
- `NextConfigComplete` and `CachedRouteKind` (types), plus the `typeof import("next/dist/…")` types used by §1.

## Test harness only (not shipped)

These are listed for completeness. They follow the [vercel/next.js deploy test](https://github.com/vercel/next.js/tree/canary/test) interface rather than app-facing APIs: `NEXT_PRIVATE_TEST_MODE`, `NEXT_TEST_*`, `__NEXT_CACHE_COMPONENTS`, `.next/BUILD_ID`, `.next/required-server-files.json`, and `_buildManifest.js` probes in `scripts/`.

## Upstream asks, by how much each would remove

1. A **stale signal from `CacheHandler.get`**. Removes the `tagsManifest` mutation.
2. **`cacheKey` and `tags` on `outputs.prerenders[]`**, plus a public cache-entry builder. Removes the route-cache-key probe, file-path parsing, `x-next-cache-tags` reads and hand-built entries.
3. **Image optimizer, static serving and instrumentation as adapter outputs** with traced assets. Removes most of §1.
4. **`@next/routing` fixes**: `nxtP` substitution, internal header filtering, data-request flag, repeated slashes, `trailingSlash`, dropped `headers()` when middleware responds.
5. **Public `cacheHandler` types**, and `basePath` + `phase` on `CacheHandlerContext`.
6. **Document `requestMeta.query` / `params` / `initURL`**, and honor `relativeProjectDir` in every runtime.
7. The **vary-by request header set** and **interception metadata** in adapter outputs.
8. A **client entry injection hook** for adapters.

Related: [RFC: Deployment Adapters API](https://github.com/vercel/next.js/discussions/77740).
