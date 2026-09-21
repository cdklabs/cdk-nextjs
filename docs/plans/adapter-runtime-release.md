# Adapter runtime: serve requests through build-output entrypoints

Self-contained implementation plan; assumes no context from the session that
wrote it. Verified against Next.js **16.3.5** (the version in `package.json`) and
`https://nextjs.org/docs/app/api-reference/adapters/`.

**How to read this doc.** Steps 1–5 are implementation order on one branch, not
separate releases. Every `file.ts:123` reference is a grep hint captured on
2026-09-21, not a stable address — find the symbol, don't trust the number.
"Decisions" near the end records choices that are already made; don't reopen them
without new information.

## Goal

Move all four `NextjsType`s off `node server.js` and onto build-output entrypoint
invocation: `@next/routing` resolves routes, a middleware runner handles
`outputs.middleware`, the existing image handler serves `_next/image`, and the
Next.js entrypoints render. No new `NextjsType`s. Functions types move from
container images to zip Lambdas. Everything ships as one PR.

**Out of scope:** `config.supportsImmutableAssets`, now
`docs/plans/immutable-static-assets.md` — its own branch and PR. No dependency in
either direction; the only overlap is a one-line merge conflict in `modifyConfig`.
Either can land first.

## Execution model: one branch, one PR

- **No env var gate.** No `CDK_NEXTJS_EXPERIMENTAL_ADAPTER_RUNTIME` in any form.
  Old and new runtimes are never both reachable from one `main` commit; selection
  is "which branch you're on."
- **No dead code left behind.** Scaffolding built during development (measurement
  scripts, throwaway harnesses) is deleted before the PR opens.
- **Keep `output: "standalone"` set until the last commit** on the branch. It
  keeps `server.js` working as a fallback while the new runtime is built beside
  it. Remove it together with the fallout listed in "Replacing
  `output: standalone`".
- **Byte-diff oracle:** the deployed stacks `main-glbl-fns`, `main-rgnl-fns`,
  `main-glbl-cntnrs`, `main-rgnl-cntrs` run the current path and stay up
  throughout. Diff the branch's responses against them.
- **Sequencing:** Functions types first (that's where the benefit is), Containers
  second, both before the PR opens. If Containers turns out substantially harder,
  that's an explicit scope conversation, not a silent deferral.

## Files touched

New:

| File | Purpose |
| --- | --- |
| `src/runtime/manifest.ts` | Manifest types shared by adapter, runtime, constructs |
| `src/runtime/handle-request.ts` | Shared core: dispatch → invoke entrypoint → respond |
| `src/runtime/lambda.mts` | `awslambda.streamifyResponse` shell (Functions) |
| `src/runtime/server.mts` | `node:http` shell (Containers) |
| `src/runtime/http/request.ts` | `IncomingMessage` shim (MIT, from serverless-http) |
| `src/runtime/http/response.ts` | Streaming `ServerResponse` shim (MIT, from OpenNext) |
| `src/runtime/middleware.ts` | `invokeMiddleware` callback |
| `src/adapter/build-outputs.ts` | Staging + manifest writer, called by `onBuildComplete` |

Modified:

| File | Change |
| --- | --- |
| `src/adapter/adapter.mts` | Drop `output: "standalone"`; call `build-outputs` |
| `src/nextjs-build/nextjs-build.ts` | Drop standalone existence check (`:198-207`), `relativePathToPackage` detection (`:247-288`), musl `sharp` download (`:397`); expose staging root + manifest path |
| `src/nextjs-compute/nextjs-functions.ts` | `DockerImageFunction` → `Function` (zip); delete `AWS_LWA_*` env (`:68-72`) |
| `src/nextjs-compute/nextjs-containers.ts` | Point health check at the new server |
| `src/nextjs-build/global-containers.Dockerfile`, `regional-containers.Dockerfile` | `COPY` staging tree instead of `.next/standalone`; run `lib/runtime/server.mjs` |
| `src/nextjs-build/functions.Dockerfile` | Delete |
| `src/nextjs-api.ts` | Comment why `minCompressionSize` (`:123`) is a no-op under `STREAM` |
| `src/nextjs-distribution.ts` | Per-group behaviors (step 5) |
| `src/root-constructs/nextjs-global-functions.ts`, `nextjs-regional-functions.ts` | `functionGroups` prop |
| `src/utils/experimental-flags.ts`, `src/nextjs-compute/nextjs-image-function.ts` | Delete dedicated image function + flag |
| `src/root-constructs/nextjs-base-construct.ts` | Stale standalone-server comment (`:38`); `healthCheckPath` no longer applies to Functions |
| `examples/shared/suppress-nags.ts` | Remove `NextjsImageFunction` branch (`:242-253`) |
| `.projenrc.ts` | Bundle `src/runtime/{lambda,server}.mts`; run `pnpm projen` after |
| `docs/breaking-changes.md` | See exit criteria |

## Commit order

1. Manifest types + `build-outputs.ts` staging and manifest writing, behind the
   still-present standalone output. Unit-testable with committed fixtures.
2. `@next/routing` dispatch, pure unit tests, no AWS.
3. Middleware runner.
4. HTTP shims + shared core + both shells. Functions first.
5. Wire constructs to the staging tree; Functions to zip; Containers Dockerfiles.
6. Delete `output: "standalone"`, the standalone-keyed code, and the dedicated
   image function.
7. Splitting (`functionGroups`).
8. Tests, docs, breaking-changes.

## Background: what the adapter API does and doesn't give us

The Deployment Adapter API is **build-time only**
([Runtime Integration](https://nextjs.org/docs/app/api-reference/adapters/runtime-integration)):
it reports what was built and how to route. Request handling, streaming, and
caching are the server's job and ours. So two independent things:

1. **Implementing `NextAdapter`** — `modifyConfig` + `onBuildComplete`, already
   registered (`src/adapter/adapter.mts`). But today's `onBuildComplete` reads
   only `ctx.distDir` and `outputs.prerenders`/`.appPages`/`.appRoutes`, to seed
   the ISR init cache. It ignores `ctx.routing`, `outputs.pages`, `pagesApi`,
   `middleware`, `staticFiles`, `repoRoot`, `config`, `buildId`, and every
   `assets`/`assetsHashes` map — and nothing in `src/` reads them either.
   Essentially all build-side work in this plan is new code in that hook (step 1).
2. **Invoking entrypoints** instead of `node server.js` — the rest of this plan.

Release notes must say "cdk-nextjs now serves requests through the adapter
entrypoints," not "now uses the adapters API," which has been true for a while.

### Replacing `output: standalone`

Standalone and the adapter are alternatives, not layers. `next build` says so
verbatim (`node_modules/next/dist/build/index.js` ~line 2782, immediately above
the `onBuildComplete` call): "in the future `output: standalone` might not be
allowed if an adapter with `onBuildComplete` is configured." Order confirmed
there: `onBuildComplete` runs **before** `writeStandaloneDirectory`.

Both produce the same closure from the same NFT traces. `getSharedNodeAssets`
(`build-complete.js:1334+`) folds into `sharedNodeAssets`, merged into *every*
output's `assets` — exactly what `writeStandaloneDirectory` hands
`copyTracedFiles`:

- traced `app-page` and `pages` server-module dependency closures,
- `.next/server/instrumentation.js` + trace when `hasInstrumentationHook`,
- every entry in `requiredServerFiles.files`. Verified against
  `examples/app-playground/.next/required-server-files.json`: 17 files including
  `.next/BUILD_ID`, `routes-manifest.json`, `prerender-manifest.json`,
  `middleware-manifest.json`, `next-font-manifest.*`,
  `required-server-files.json` itself, and `.next/package.json` — the
  `{"type":"commonjs"}` shim that makes `.next/server/**/*.js` resolve as CJS, so
  module resolution works without a standalone tree.

Standalone carries nothing else we need except the two things we are deliberately
replacing: its generated `server.js` and its root `package.json` start shim.

**One real gap:** `writeStandaloneDirectory` also copies `.env` and
`.env.production` (it filters `loadedEnvFiles` to exactly those two).
`build-complete.js` has no env-file handling at all, so dropping standalone
silently drops those files unless we stage them ourselves — step 1, job 2.

**Fallout, all in scope for this branch:** the three Dockerfiles that
`COPY .next/standalone ./` and run `server.js`; `NextjsBuild`'s hard fail when
`.next/standalone` is absent and its `relativePathToPackage` auto-detection by
*finding `server.js` with a `.next` sibling* (replaced by `repoRoot` +
`requestMeta.relativeProjectDir`); the `sharp` surgery against
`.next/standalone/node_modules` and the `@img/sharp-linuxmusl-*` download, which
exists only because the standalone server runs on Alpine.

### Packaging budget

Zip Lambdas cap at **250 MB unzipped**. Entrypoints `require` `next/dist/...` at
runtime, so the `next` closure ships with them. `SharedRouteFields.assets` is
documented as "all necessary traced assets that could be loaded by the output to
handle a request" (`node_modules/next/dist/build/adapter/build-complete.d.ts`);
each output's `<entry>.nft.json` trace is merged with `sharedNodeAssets` /
`pagesSharedNodeAssets` / `appPagesSharedNodeAssets` (`handleTraceFiles`). The
`next` runtime is in there.

Measured 2026-09-21, `examples/app-playground` after a real build:

| Thing | Unzipped |
| --- | --- |
| `.next/standalone` (whole closure) | 39 MB |
| `.next/standalone/node_modules` | 23 MB |
| dedicated image asset (glibc `sharp` + handler) | 19 MB |

~60 MB for a non-trivial app against a 250 MB cap, so zip is the default
packaging for Functions types: no Docker, glibc `sharp` only.

**Re-measured 2026-09-21 against the staging tree this plan builds** (commit-order
step 5, `examples/app-playground`, one function for everything):

| Thing | Unzipped | Files |
| --- | --- | --- |
| staged deployment root, as staged | 39 MB | 953 |
| **deployed function, symlinks dereferenced** (what counts against the cap) | **49 MB** | 1522 |
| ⤷ `node_modules` (traced `next` + `sharp` + closures) | 34 MB | |
| ⤷ `app-playground/.next` (entrypoints, prerenders, static) | 14 MB | |
| ⤷ `cdk-nextjs-runtime/` (both shells, bundled) | 2 MB | |
| published zip | 21 MB (21,558,128 B) | |

Dereferencing is what `cdk-assets` does when it zips, and it is why the byte total
*rises*: pnpm's store links collapse into copies. (An earlier revision of this
table read 54 MB / 942 as-staged and drew the opposite conclusion. That number was
measured on a `.next` that had accumulated across several builds; from a clean
`.next` the staged tree is smaller than its own dereferenced form, as it must be.)
49 MB is **20% of the cap** for one function serving every route, image
optimization included — against 39 MB + a second 19 MB image function before.
Measured with `cp -RL <cdk.out asset> /tmp/x && du -sm /tmp/x`, after
`rm -rf examples/app-playground/.next`.

**If a real app exceeds the cap, the answer is splitting (step 5), never a
container escape hatch.** The cap is per function, so duplicating the ~20–40 MB
shared base across N functions costs nothing against any one budget; the term
that grows without bound is the consumer's own app code, which is what splitting
divides. Two honest limits to document alongside it:

- Splitting only removes **route-local** code. Anything reachable from a shared
  root layout, `instrumentation`, or middleware is traced into every output, so
  one globally imported heavy dependency stays in all N functions. The remedy is
  a dynamic `import()` in the consumer's code.
- N × base counts against the region's Lambda code-storage quota (75 GB default,
  soft) and multiplies asset upload and deploy time. README-worthy at high split
  counts; not a correctness concern.

## Step 1 — build outputs (`onBuildComplete`)

The spine of the plan, all in one hook. Today it does one job; it grows to seven.

### Artifact contract

Write everything under `join(ctx.distDir, "cdk-nextjs-adapter")`, matching the
existing `cdk-nextjs-init-cache` convention:

```
.next/cdk-nextjs-adapter/
  manifest.json                 # AdapterManifest, below
  app/<repo-root-relative key>  # staged union of `assets` — the standalone replacement
```

The existing `.next/cdk-nextjs-init-cache/` tree is unchanged.

`app/` is the deployment root: at runtime `process.cwd()` is the root of this
tree, and `relativeProjectDir` bridges it to the project dir. cdk-nextjs's own
bundled runtime files are copied to `app/cdk-nextjs-runtime/` at synth (Lambda
handler `cdk-nextjs-runtime/lambda.handler`), a reserved key that cannot collide
with repo paths.

```ts
// src/runtime/manifest.ts
export interface AdapterManifest {
  readonly version: 1;
  readonly buildId: string;
  /** From `process.cwd()` (= staging root) to the Next.js project dir. Passed as
   *  `requestMeta.relativeProjectDir`. "" when the app is at the repo root. */
  readonly relativeProjectDir: string;
  readonly config: {
    readonly basePath: string;
    readonly trailingSlash: boolean;
    readonly assetPrefix: string;
    /** `ResolveRoutesParams["i18n"]`-shaped, narrower than NextConfigComplete. */
    readonly i18n: unknown | null;
  };
  /** `ctx.routing` verbatim, including `middlewareMatchers`. */
  readonly routing: unknown;
  /** pages + pagesApi + appPages + appRoutes + staticFiles pathnames. */
  readonly pathnames: string[];
  /** Route *template* (`/blog/[slug]`) → entrypoint. */
  readonly entrypoints: Record<string, AdapterEntrypoint>;
  readonly middleware: AdapterMiddleware | null;
  readonly staticFiles: string[];
  /** Step 5 only: group name → route templates. Absent when not splitting. */
  readonly groups?: Record<string, string[]>;
}

export interface AdapterEntrypoint {
  readonly id: string;
  /** Repo-root-relative POSIX key inside the staging tree. Never absolute. */
  readonly filePath: string;
  readonly type: "app-page" | "app-route" | "page" | "page-api";
}

export interface AdapterMiddleware {
  readonly id: string;
  readonly filePath: string;
  readonly env: Record<string, string>;
}
```

**Every path in the manifest is a repo-root-relative POSIX key**, never a
build-machine absolute path. This is the single most load-bearing detail in the
contract: absolute paths work on the build machine and fail in Lambda.

### The seven jobs

1. **Reject non-Node outputs, everywhere.** Not just middleware. `export const
   runtime = 'edge'` on a page or route handler lands in
   `outputs.appPages`/`appRoutes`/`pages`/`pagesApi` with `runtime: 'edge'`,
   `assets: {}`, and an `edgeRuntime` descriptor needing `globalThis._ENTRIES` and
   a sandbox (`build-complete.js`, `handleEdgeFunction`). Throw on **any** output
   with `runtime !== 'nodejs'`, naming the offending `sourcePage` and linking
   [edge-runtime-deprecated](https://nextjs.org/docs/messages/edge-runtime-deprecated).
   Guarding middleware alone leaves a silent failure mode for edge pages.
2. **Stage the deduped union of `assets`.** The largest new job; this is what
   replaces standalone. For every Node output we ship, copy `assets[key]` →
   `app/<key>`. Dedup is by key — the traced `next` closure is merged into every
   output's `assets`, so N outputs overwhelmingly repeat keys. **Also stage
   `.env` and `.env.production`** if present; `assets` does not contain them.
3. **Use `assetsHashes` as a conflict check, not a size optimization.** Dedup by
   key already collapses duplicates. What the hashes buy is detecting two outputs
   mapping the **same key to different content** — unpackageable into one Lambda,
   so fail the build loudly instead of letting last-write-wins pick. They also
   give step 5 its shared-vs-unique byte accounting and the deployment asset an
   integrity assertion (staged hash == build-time hash).
4. **Persist `ctx.routing` verbatim** plus `pathnames`. `middlewareMatchers`
   comes along for free, which is what makes middleware gating free at runtime.
5. **Persist the template → entrypoint map.** `resolveRoutes` returns a route
   *template*; the runtime needs `{ id, filePath, type }` for it.
6. **Middleware artifacts:** `middleware.filePath` and its `assets` staged at
   repo-root-relative keys like job 2, plus `middleware.config.env`.
   `config.matchers` arrives inside `ctx.routing.middlewareMatchers`.
7. **Keep the existing init-cache seeding as-is.** Add PPR shell /
   `postponedState` persistence only if step 4's PPR sequence shows it's needed.

Also emit the `maxDuration` / `preferredRegion` warnings described in step 5 —
this hook is the only place that holds `outputs[].config`.

**Deliberately not consumed:** `outputs.prerenders[].config`'s `allowQuery` /
`allowHeader` / `bypassFor` / `bypassToken`. These are cache-key and cache-bypass
concerns, and in non-minimal mode the entrypoint's own response cache reads the
prerender manifest and handles them internally. Don't reimplement them in the
dispatcher; revisit only if an ISR e2e shows a cache-key mismatch.

**Tests:** commit `routing` + `outputs` JSON from a few fixture builds
(app-playground, an i18n app, a `basePath` app) and assert the manifest produced.

## Step 2 — dispatch via `@next/routing`

**Do not hand-write a router.** `@next/routing` is first-party, published, zero
dependencies, versioned in lockstep with `next` (`16.3.5` exists today; 378
versions published, 31.5 kB). Add it **pinned exact** to the `next` version — a
`next` bump is a matching `@next/routing` bump.

```ts
import { resolveRoutes } from "@next/routing";

const result = await resolveRoutes({
  url: new URL(requestUrl),
  buildId,
  basePath: config.basePath || "",
  i18n: config.i18n, // needs a cast; see below
  headers: new Headers(requestHeaders),
  requestBody, // ReadableStream, required even for GET
  pathnames,
  routes: routing,
  invokeMiddleware: async (ctx) => {
    /* step 3 */
  },
});
```

Returns `middlewareResponded`, `externalRewrite`, `redirect`, `resolvedPathname`
(the template, e.g. `/blog/[slug]`), `resolvedQuery`, `invocationTarget` (the
concrete pathname/query to invoke), `resolvedHeaders`, `status`, `routeMatches`.
That covers locale normalization, `_next/data` normalization, `.rsc` suffixes,
`basePath`, rewrite/redirect/header ordering, and dynamic param extraction.

Remaining work:

- Map `resolvedPathname` → entrypoint `filePath` via `manifest.entrypoints`, and
  handle each non-entrypoint outcome: `redirect`, `externalRewrite`,
  `middlewareResponded`, `staticFiles` → S3/CloudFront.
- Route `_next/image` to `src/image-optimization/`. It is **not** an adapter
  output type — `AdapterOutputs` has no image-optimizer member — so it is
  permanently our own code, reached through dispatch *after* middleware. That
  interception is the whole reason this work started.
- **Lazy-require entrypoints per dispatch decision.** Eagerly requiring all of
  them makes every cold start pay for the whole app. Measure the result (exit
  criteria).

Two API details that bite: `requestBody: ReadableStream` is required, not
optional (a GET needs an empty stream, and the same body must survive both
middleware and the entrypoint — see body teeing in step 4); and
`ResolveRoutesParams.i18n` is narrower than `NextConfigComplete["i18n"]`, so the
docs' `i18n: config.i18n` needs a cast.

**Tests:** assert dispatch decisions for synthetic URLs against the step 1
fixture manifests. Pure unit tests, no AWS.

## Step 3 — middleware runner

Narrowly scoped: the `invokeMiddleware` callback `resolveRoutes` calls, nothing
more. Build side is covered by step 1 jobs 1 and 6.

**The signature is web-style even for `runtime: 'nodejs'`.**
`.next/server/middleware.js` exports (see
`node_modules/next/dist/build/templates/middleware.js` and its `.d.ts`):

```ts
handler(request: Request, ctx: { waitUntil?, signal?, requestMeta? }): Promise<Response>
```

Not `(req, res, ctx)`. Next's own `next-server` reaches the same module through
its default export with an internal `{ handler, request, page }` options object —
ignore that path; `handler` is the adapter-facing export.

**Don't hand-write the `x-middleware-*` translation.** `@next/routing` exports
`responseToMiddlewareResult(response, requestHeaders, url)`, which handles
`x-middleware-override-headers`, `x-middleware-request-*`,
`x-middleware-rewrite`, `location` → `redirect`, and `x-middleware-refresh` →
`bodySent`. So the whole step is:

```ts
invokeMiddleware: async ({ url, headers, requestBody }) => {
  const request = new Request(url, { headers, body: requestBody /* method, duplex */ });
  const response = await middlewareHandler(request, { waitUntil, requestMeta });
  return responseToMiddlewareResult(response, headers, url);
};
```

`process.env.__NEXT_BASE_PATH` / `__NEXT_I18N_CONFIG` / `__NEXT_TRAILING_SLASH`
and friends, which the template reads, are DefinePlugin-inlined at build time
(`node_modules/next/dist/build/define-env.js`) — verified, no runtime env
plumbing needed.

**Don't write a matcher evaluator.** `resolveRoutes` gates middleware itself via
`routes.middlewareMatchers` — `shouldInvokeMiddlewareForRequest` matches
`sourceRegex` and evaluates `has`/`missing` with a decoded-pathname retry. And
`ctx.routing.middlewareMatchers` comes from `outputs.middleware.config.matchers`,
which Next builds with the injected
`{ type: 'header', key: 'x-prerender-revalidate', value: previewModeId }`
`missing` rule already present (`build-complete.js`, both the edge and
`hasNodeMiddleware` branches). ISR revalidation requests therefore skip user
middleware with no work on our side.

## Step 4 — one runtime core, two shells

One asset holds all Node entrypoints, the union of their `assets`, the middleware
runner, the image handler, and the dispatcher. One `handleRequest(req, res)` core
wrapped by two shells: a Lambda handler (`awslambda.streamifyResponse`) for
Functions types and a `node:http` server for Containers types. Invoke entrypoints
as `handler(req, res, { waitUntil, requestMeta })`.

**The Lambda shell is the largest new code surface in this plan, not a wrapper.**
Today Lambda Web Adapter hands `server.js` real `IncomingMessage`/
`ServerResponse` objects from a real socket (`AWS_LWA_INVOKE_MODE:
response_stream`, `src/nextjs-compute/nextjs-functions.ts:68`). Dropping the
container means synthesizing both from a Function URL / API Gateway event and
piping `res` into `responseStream`. Use **one** synthesized implementation in
both shells — not real `node:http` objects for Containers — so the container e2e
suite exercises the same code Lambda runs.

### Prior art (researched; don't write from scratch)

**Request side: solved, ~35 lines.** `serverless-http` (MIT, Doug Moscrop, v4.0.0,
Node 24 tested) `lib/request.js`: `class IncomingMessage extends
http.IncomingMessage` with a fake socket object literal (`{ encrypted: true,
readable: false, remoteAddress, address: () => ({ port: 443 }), end/destroy:
Function.prototype }`), `Object.assign` of `method`/`url`/`headers`/
`httpVersion`/`complete: true`, and `_read = () => { push(body); push(null) }`. It
also sets `content-length` from the body per RFC 9110. **Don't add the package as
a dependency** — it's an Express/Koa wrapper with buffered responses, 25 files.
Copy those ~35 lines with MIT attribution, as OpenNext did
(`packages/open-next/src/http/request.ts`).

**Response side: no package exists.** Nobody publishes a streaming
`ServerResponse` shim standalone; `@vendia/serverless-express` and
`@codegenie/serverless-express` don't support response streaming at all. The one
real implementation is OpenNext's
[`OpenNextNodeResponse`](https://github.com/opennextjs/opennextjs-aws/blob/main/packages/open-next/src/http/openNextResponse.ts)
— `extends Transform implements ServerResponse`, **~400 lines / 13 KB**, MIT
(© 2022 SST, compatible with this repo's Apache-2.0, needs attribution). Use it
as the reference; that size is the honest budget. What it encodes that we would
otherwise learn the hard way:

- **The response *is* the stream.** `flushHeaders()` writes status/headers and
  `pipe`s into the Lambda response stream; `_transform` calls it lazily if Next
  never did.
- **Empty bodies can hang the response** on some AWS accounts — a streaming bug
  AWS has shipped repeatedly. OpenNext's escape hatch pushes a literal
  `"SOMETHING"` when `bodyLength === 0` (`OPEN_NEXT_FORCE_NON_EMPTY_RESPONSE`).
  cdk-nextjs already hit a cousin: the space byte written for 304s in
  `src/image-optimization/handler.mts`. Expect to need a deliberate zero-length
  policy plus an e2e asserting a 204/304 doesn't hang.
- **`set-cookie` must live outside the flat header map** and needs comma-splitting
  with a negative lookbehind so `Expires=Thu, 01 June` doesn't split
  (`http/util.ts`).
- **`Location` can arrive as an array** — Next does this when a `cacheHandler`
  `get` returns null on a page with `redirect()`. Take the last value and warn;
  don't comma-join.
- **Client aborts:** wire the invocation's abort signal to `res.destroy()`, which
  is what makes `request.signal.onabort` work in route handlers.
- **`writeHead` headers may be a flat even/odd array**, not tuples.
- **Next calls non-standard methods:** `originalResponse`, `sent`,
  `getHeaderValues`, `send`, `body`, `onClose`, `redirect` (including the 308
  `Refresh` workaround).
- Next returns 500 error pages with wrong `cache-control`; patch on the way out.
- `addTrailers`, `assignSocket`/`detachSocket`, `writeContinue`,
  `writeEarlyHints`, `writeProcessing`, and `setTimeout` are all `throw` in
  OpenNext — Next never calls them. Don't budget for trailers.

Don't copy OpenNext wholesale: a chunk of its response complexity
(`initialHeaders`, `mergeHeadersPriority`, the middleware-header merge) exists
because it reimplements routing, which `resolveRoutes` +
`responseToMiddlewareResult` own for us. Take the `ServerResponse` mechanics,
leave the routing compensation.

### What the container path gave us for free

- **Compression** — see below.
- **Body teeing.** `resolveRoutes` hands `requestBody` to `invokeMiddleware`,
  which consumes it; the entrypoint needs the same body. Mirror `next-server`'s
  `getCloneableBody()` / `cloneBodyStream()` / `finalize()` rather than reading
  the stream twice.
- **Health/readiness checks.** `AWS_LWA_READINESS_CHECK_*` and `healthCheckPath`
  stop meaning anything for Functions types.

### Compression: gzip in the shared core is the only option

Both managed layers were checked and ruled out for **streamed** responses.

`minCompressionSize: Size.bytes(0)` is already set (`src/nextjs-api.ts:123`) but
is a no-op, because cdk-nextjs also sets `ResponseTransferMode.STREAM`
(`nextjs-api.ts:277`, `:290`), and per
[Stream the integration response](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html)
STREAM drops endpoint caching, content encoding ("If you want to compress your
integration response, do this in your integration"), and VTL transformation.
Today that's masked by LWA already returning `content-encoding: gzip`. Leave a
code comment so nobody "fixes" the absence later.

CloudFront can't cover it either: per
[Serve compressed files](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html)
the origin must send `Content-Length`, which a streamed response by definition
does not (also gated on 1,000–10,000,000 bytes and status 200/403/404). What
CloudFront *does* still cover, so don't over-scope: non-streamed dynamic
responses and all S3 static assets (`BehaviorOptions.compress` defaults true,
`CACHING_OPTIMIZED` already keys on gzip/br). The gap is exactly **streamed
dynamic HTML and RSC payloads** — the large text responses that benefit most.

**Implementation:** in the shared core, when `Accept-Encoding` permits and Next
hasn't set `content-encoding`, pipe `res → zlib.createGzip() → responseStream`,
set `content-encoding: gzip`, and never emit `content-length`. In the *shared*
core, not the Lambda shell, so Containers behave identically and the container
e2e covers it. gzip over brotli: brotli's streaming throughput at default quality
is poor, and CloudFront prefers `br` only when the origin didn't already encode,
which stops applying once we set the header. Add an e2e asserting
`content-encoding: gzip` on streamed HTML and on an RSC payload for both
Functions types — nothing asserts this today.

### `requestMeta` and `waitUntil`

Documented `requestMeta` fields
([Invoking Entrypoints](https://nextjs.org/docs/app/api-reference/adapters/invoking-entrypoints)):
`relativeProjectDir` (the in-Lambda layout is load-bearing — pin it and assert
it), `hostname` (route handlers building absolute URLs), `revalidate` (back it
with the existing S3/DynamoDB path), `render404` (pages-router `notFound: true`).

`ctx.waitUntil`: Lambda has **no** post-response keepalive; the environment
freezes when the handler resolves. Close the response stream, *then* `await` the
pending promises before resolving. Client latency is unaffected, billed duration
extends. Skipping the await leaves background revalidation frozen mid-flight.

### PPR: assume zero work, prove it

Because we invoke entrypoints in-process and **not** in minimal mode, the
entrypoint's own response cache (backed by our `cacheHandler`) already does the
shell + resume chain internally, exactly as `next start` does. The read of
`requestMeta.postponed` in `base-server.js` is gated only on `isRoutePPREnabled`,
not on `minimalMode` — so passing `postponed` opts *in* to the manual path, where
**we** must stream `concat(shellStream, resumedStream)` as one response (see
[Implementing PPR in an Adapter](https://nextjs.org/docs/app/api-reference/adapters/implementing-ppr-in-an-adapter)).

1. **Do nothing first.** `src/adapter/cache-handler.ts` stores
   `IncrementalCacheValue` opaquely, `postponed` included, so shell and postponed
   state are already written atomically by one `set()`. Add a PPR e2e and see
   whether it passes with no resume code.
2. **Only if it fails**, implement the manual chain: persist shell +
   `fallback.postponedState` at build time; at request time stream the cached
   shell while invoking the handler with `requestMeta: { postponed }` and
   concatenate. `req.method = 'POST'` is **not** required — `base-server.js`
   merely permits non-GET/HEAD when a postponed state is present.
3. **Degrade gracefully either way:** missing or stale shell/postponed state
   falls back to a full server render rather than failing.

To select PPR outputs, prefer the `PrerenderClassification` fields on
`outputs.prerenders[]` — `compute: 'resuming'`, `routeType: 'shell'`,
`response: 'initial'` — over `config.renderingMode === 'PARTIALLY_STATIC'`.

## Step 5 — splitting (`functionGroups`)

Consumer-declared route groups, each packaged as its own Lambda with only the
`assets` of its outputs, plus routing at CloudFront / API Gateway. Because step 2
keeps dispatch separate from invocation, this is a packaging change plus
distribution wiring, with no runtime rework. It ships in this release as an
opt-in prop; the default is no grouping and one function, exactly as today.

**One purpose: staying under the 250 MB unzipped cap.** It is the documented
remedy for a size error and the only one this construct offers.

```ts
export interface NextjsFunctionGroup {
  /**
   * Unique suffix for the group's construct id and function name.
   * `default` is reserved. Must match /^[a-zA-Z0-9-]+$/.
   */
  readonly name: string;
  /**
   * Routes owned by this group. Each entry is either an exact static path
   * (`/pricing`) or a subtree (`/api/reports/**`). Dynamic segments are not
   * accepted — see below.
   */
  readonly routes: string[];
  /** Per-group Lambda overrides — memorySize, timeout, etc. */
  readonly overrides?: OptionalFunctionProps;
}
```

Added as `readonly functionGroups?: NextjsFunctionGroup[]` to
`NextjsGlobalFunctionsProps` and `NextjsRegionalFunctionsProps` — **not** to
`NextjsBaseProps`. Same reasoning as the dedicated image function: the Containers
types would accept it and silently ignore it, and they don't need it (ECR images
cap at 10 GB). `OptionalFunctionProps` already exists in
`src/generated-structs/`. JSII-safe as written: struct of `string`, `string[]`,
nested struct; no unions, mapped types, or enums.

### No dynamic segments in patterns

**A pattern is an exact static path (`/pricing`) or a subtree
(`/api/reports/**`). Anything containing `[id]`, `[...slug]`, `[[...slug]]`, or a
`(group)` segment is a synth error.**

Group patterns become CloudFront behavior path patterns, and CloudFront supports
only `*`/`?` — the character validation at `src/nextjs-distribution.ts:442`
already rejects `[` and `]`. So `/dashboard/[id]` could only deploy as behavior
`/dashboard/*`, which also matches `/dashboard/settings` and `/dashboard/a/b/c`.
If those live in another group, CloudFront sends them to a function whose zip
lacks their entrypoint — a 404 or crash on a route the consumer explicitly
assigned elsewhere. `NextjsGlobalFunctions` is the most-used construct here, so
accepting a syntax whose granularity we can't honor would be misleading.

The restriction costs nothing that was ever achievable: `/dashboard/**` →
behavior `/dashboard/*` is the same URL space exactly; `/pricing` → `/pricing` is
exact. The only loss is splitting a dynamic route from a *sibling* under the same
parent (`/dashboard/[id]` in group A, `/dashboard/settings` in group B) — which
is precisely what CloudFront cannot express. Isolating one heavy dynamic route
still works as a subtree: `/api/report/**` covers `/api/report/[id]`.

**Apply the same restriction to `NextjsRegionalFunctions`** even though API
Gateway REST could express `/{id}` precisely, so a consumer switching type (e.g.
to Regional for GovCloud) doesn't silently get different grouping. Note in code
that the Regional limit is a consistency choice, not a technical one.

### Resolution rules

- **Longest matching pattern wins.** The identical pattern in two groups is an
  error; `/api/**` in one and `/api/reports/**` in another is fine, and the more
  specific takes it.
- **CloudFront behavior order is load-bearing.** CloudFront takes the *first*
  matching behavior and CDK's `addBehavior` appends, so group behaviors must be
  added most-specific-first or `/api/*` shadows `/api/reports/*` and longest-wins
  silently inverts at the edge. Assert with a synth test, not careful code.
- **A pattern matching zero output templates is a synth error.** Cheap, and it
  catches the typo that would otherwise leave a route in the default group.
- Anything unassigned falls into an implicit `default` group.
- Prerendered and static outputs need no assignment — they're S3 objects.

Patterns match against the route templates in `manifest.entrypoints`, which is
also what makes the zero-match check possible.

Every group's zip contains the dispatcher, middleware runner, image handler, and
the `assets` of its own outputs. Middleware and the shared `next` closure are
duplicated by design.

### Routing limits

**Global Functions:** one CloudFront behavior per route *pattern* (not per
group), pointing at that group's Function URL origin. This is the binding limit —
the distribution already spends behaviors on `_next/image*`, `_next/static*`,
`*`, and one per `public/` entry, with an existing throw at
`publicDirEntries >= 22` (`src/nextjs-distribution.ts:432-437`, `:439-453`). Keep
patterns few and coarse, and make exceeding the budget throw an error that says
*that*, not a raw CloudFront limit message.

**Regional Functions:** API Gateway REST resources, 300 per API (soft), so
grouping is cheap.

### Build-side plumbing

`onBuildComplete` can't read CDK props — it runs inside `next build` — but
`CDK_NEXTJS_INIT_CACHE_DIR` (`src/nextjs-build/nextjs-build.ts:181`) is
precedent. **Pass the resolved group config in via env and have the adapter stage
one directory per group directly**, since it already holds the absolute source
paths in `assets`. (The alternative — stage the union plus a manifest and have
the constructs do per-group subset copies at synth — is a simpler contract but
copies the bytes twice.)

**Fail at synth, not at deploy.** Lambda enforces 250 MB at CloudFormation time,
so measure each staged group at synth and throw naming the group, its size, and
the suggestion to split further. A good error here is most of this feature's
value.

### Warn on dropped route config

`maxDuration` and `preferredRegion` are not honored (see Decisions). An author
who set them asked for something explicitly, so warn rather than ignore:

- **Where:** `onBuildComplete`, which holds `outputs[].config`. `NextjsBuild`
  runs `next build` with `stdio: "inherit"`
  (`src/nextjs-build/nextjs-build.ts:178-179`), so adapter output reaches the
  user's terminal.
- **How:** ``console.warn(`${LOG_PREFIX} ...`)`` per the existing convention
  (`src/constants.ts:8`; e.g. `nextjs-build.ts:330`, `:441`). The codebase uses
  no CDK `Annotations`; don't introduce it.
- **Content:** once per config key, not per route — collect the offending
  `sourcePage`s and emit one line each for `maxDuration` and `preferredRegion`,
  naming a few routes, stating cdk-nextjs doesn't honor the value, and pointing at
  the function `overrides` prop for `timeout`.
- Warn only, never throw. Route-level `maxDuration` is valid Next.js.

## Testing

Next.js ships a
[compatibility harness](https://nextjs.org/docs/app/api-reference/adapters/testing-adapters)
that runs vercel/next.js's own e2e suite against a real deployment — a far better
correctness signal than any fixture app we would write, and the primary gate for
this work.

**Cost model.** The deploy script runs with `cwd` set to the isolated temporary
app the harness creates, and it creates a different app per test. So it is **one
CDK deploy per test file**, not one per `NextjsType`; there's no way to deploy
four stacks up front and point shards at them. For Global types that means
hundreds of CloudFront distributions per run (~5–15 min to create, again to
delete), which won't fit a 60-minute shard and will hit account quotas. So:

- Run the harness against **`NextjsRegionalFunctions` only** — API Gateway + zip
  Lambda, no CloudFront, no Docker build once step 4 lands, so a deploy is ~1–2
  minutes. It exercises the same `handleRequest` core as every other type.
- Trigger on `workflow_dispatch` + nightly, not per commit.
- Trim with `NEXT_EXTERNAL_TESTS_FILTERS` rather than all 16 shards.
- `examples/e2e-tests/` stays the per-commit gate on all four types.

Three executables in `scripts/`, pointed at by env vars:

- `NEXT_TEST_DEPLOY_SCRIPT_PATH` — deploys the harness's temp app; **prints only
  the deployment URL to stdout**, diagnostics to stderr, non-zero exit on
  failure. One stack per invocation, named from the temp app directory so
  concurrent shards don't collide.
- `NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH` — must print lines starting `BUILD_ID:`,
  `DEPLOYMENT_ID:`, `NEXT_SUPPORTS_IMMUTABLE_ASSETS:`, then any logs. Separate
  process, so persist those from the deploy script (e.g. `.adapter-build.log`)
  and replay them. The marker value is `"1"`/`"0"`, not `true`/`false`; print `0`
  while this plan is in flight and flip to `1` when
  `docs/plans/immutable-static-assets.md` lands.
- `NEXT_TEST_CLEANUP_SCRIPT_PATH` — tears the stack down. **Not optional here:**
  with a stack per test, a missing or failing cleanup leaks dozens of stacks per
  run. Make it idempotent, verify it runs on test failure, and add a scheduled
  sweeper that deletes orphaned harness stacks by tag.

Harness run config: `NEXT_TEST_MODE=deploy`,
`NEXT_EXTERNAL_TESTS_FILTERS=test/deploy-tests-manifest.json`, `ADAPTER_DIR`,
`NEXT_ADAPTER_PATH` pointing at the built adapter, then
`node run-tests.js --timings -g <n>/16 -c 2 --type e2e` from a next.js checkout.

**Strengthen the existing suite too.** `examples/e2e-tests/src/*.test.ts` asserts
status codes and one content-type, and **it cannot see the class of bug that
produced this work** — a broken `sharp` returning HTTP 200 with unoptimized
original bytes, through four green e2e jobs. Add byte- and header-level
assertions (`etag` shape: Next.js uses sha256/base64url, S3 uses MD5 — that
difference is what caught it), plus a middleware e2e proving a 403 or redirect on
`_next/image`.

Still absent: the first CDK assertion test in `test/` (only `tsconfig.json`
today). Blocked on `NextjsBuild` running `next build` in its constructor — needs
`skipBuild: true` plus a committed fixture `.next`.

## Decisions (do not relitigate)

- **`minimalMode`: never set it.** Not part of the documented `requestMeta` API;
  it's an internal field read via `Boolean(getRequestMeta(req, 'minimalMode'))`,
  so absent means false. False is the non-minimal path, which keeps the
  incremental cache inside the entrypoint and `src/adapter/cache-handler.ts`
  working. Don't pass it, and don't build anything depending on its semantics.
- **`onCacheEntryV2`: not wired.** `src/adapter/cache-handler.ts` already passes
  `IncrementalCacheValue` through opaquely, `postponed` included, so shell +
  postponed state are stored atomically by one `set()`. Revisit only if PPR step 1
  fails.
- **PPR is origin-only** (what `next start` does, via direct invocation), not the
  guide's "CDN Shell + Origin Compute" variant. That variant needs the CDN to
  splice a cached edge response with a streamed origin response into one HTTP
  response, and CloudFront has no primitive for it (no Lambda@Edge or CloudFront
  Functions response streaming, no edge-KV-plus-origin-splice). A distinct, much
  larger body of edge-compute work.
- **No container escape hatch for oversized apps.** Splitting is the answer; see
  "Packaging budget".
- **Splitting is not driven by `config.maxDuration` or `preferredRegion`; both
  are dropped with a warning.** `preferredRegion` would require multiple regional
  stacks plus latency/geo routing — a multi-region architecture, not a packaging
  option. `maxDuration` is per-route while a Lambda timeout is per-function, so a
  group's timeout would have to be the max across members: implicit coupling, in
  exchange for a value the consumer can already set via `overrides`. And
  inferring groups from either gives a consumer splitting purely for size nothing
  to key off.
- **Delete the dedicated image Lambda**, its flag
  `CDK_NEXTJS_EXPERIMENTAL_DEDICATED_IMAGE_FUNCTION`
  (`src/utils/experimental-flags.ts`), `src/nextjs-compute/nextjs-image-function.ts`,
  and the branching in `examples/shared/suppress-nags.ts` and `NextjsApi`. This
  supersedes `docs/plans/phase-0-image-function-opt-in.md`, which planned to keep
  the flag and flip its default; that file's own code comment already anticipates
  the deletion. Justification: the flag existed for the musl-vs-glibc `sharp`
  split (the Docker/LWA server function needs musl binaries), and zip packaging
  makes the server function glibc, so one Lambda holds both. Cost: independent
  memory/timeout sizing for image requests, and `_next/image` **cannot** be
  re-split by step 5 since it isn't an adapter output. Revisit sizing separately
  if image latency regresses.
- **`@next/routing` is exact-pinned to the `next` version** and bumped with it.

## Exit criteria

- Official harness green on `NextjsRegionalFunctions` for the filtered manifest
  (or every exclusion documented with a reason), with harness stacks verifiably
  cleaned up. Not gated on the Global types — see the cost model.
- All existing e2e suites green, including `streaming`, `isr`, `revalidation`,
  `server-actions`, on **all four** `NextjsType`s.
- Middleware e2e proving interception on `_next/image`.
- A PPR e2e, which also settles whether manual resume code is needed.
- Response compression verified on both Functions types (the LWA replacement).
- Cold-start measurement on a non-trivial app versus the current path, with
  entrypoints lazily required.
- `functionGroups` documented as opt-in, with at least one e2e exercising a split
  configuration, and the README naming it as the response to a 250 MB size error.
- `docs/breaking-changes.md` covering the removed
  `CDK_NEXTJS_EXPERIMENTAL_DEDICATED_IMAGE_FUNCTION` flag and the
  `nextjsFunctionsProps.dockerImageFunctionProps` override keys, which become
  meaningless once Functions move from container images to zip Lambdas.
- No env var, flag, or dead code path left behind from development.
