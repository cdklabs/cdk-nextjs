# Adapter runtime — one branch, one release, all four `NextjsType`s

Self-contained; assumes no context from the session that wrote it.

Verified against Next.js **16.3.5** (the version in `package.json`) and the
adapters docs under `https://nextjs.org/docs/app/api-reference/adapters/`.

## Decision

Move **all four existing `NextjsType`s** onto adapter entrypoint invocation:
`@next/routing` resolves routes, a middleware runner handles `outputs.middleware`,
the existing image handler serves `_next/image`, and the Next.js entrypoints
render. No new `NextjsType`s. Phases 1-3 ship as one user-facing release.

**Phase 4 (per-output Lambda splitting) is out of this release.**

## Execution model: one branch, no runtime-selection flag

Everything in this plan — Spike 0 through Phase 3, plus the testing work —
happens on a single feature branch and merges to `main` as one PR (or a small
number of PRs merged in immediate succession, with no release cut in between).
`main` runs `server.js` unchanged for the entire duration of development; the
branch is where the new runtime is built, iterated on, and proven, and nothing
crosses over until it's ready to fully replace the old path.

This is a deliberate departure from `docs/plans/phase-0-image-function-opt-in.md`,
which shipped incrementally to `main` behind
`CDK_NEXTJS_EXPERIMENTAL_DEDICATED_IMAGE_FUNCTION=1` across many small merged
PRs. That pattern is not used here:

- **No env var gate.** There is no `CDK_NEXTJS_EXPERIMENTAL_ADAPTER_RUNTIME`
  or equivalent, in any form — undocumented or otherwise. The old and new
  runtimes are never both reachable from the same `main` commit. Selection
  between them is "which branch you're on," not a flag evaluated at synth or
  request time.
- **No incremental merges to `main`.** Phase boundaries are checkpoints on the
  branch (commits, or PRs against the branch if that helps reviewability), not
  points where anything ships to users. Semantic-release does not see this work
  until the branch merges.
- **CI runs on the branch,** the same way it would on any long-lived feature
  branch — via normal branch/PR CI against the branch, not via a matrix that
  toggles a flag on `main`.

Consequence: there is no cheap "known-good `server.js` path" oracle available
on the same commit to byte-diff against mid-development, since the two paths
never coexist. That's fine — the official adapter compatibility harness (see
Testing, below) is the primary correctness gate regardless, and is a stronger
signal than a homegrown byte-diff would have been. If a byte-diff comparison
is useful while iterating, do it by checking out `main` in a worktree and
diffing output against the branch, not by carrying a flag.

The other reason an earlier draft hedged with new `*_ADAPTER` types or a flag
is also gone: the dispatcher was going to be a large hand-written component,
which made sharing it between Lambda and Fargate look expensive. `@next/routing`
supplies it (below), so one request path across all four types is cheap enough
to build and prove out entirely on the branch before it ever reaches `main`.

## Terminology, because "go all in on adapters" is two separate things

The docs are explicit
([Runtime Integration](https://nextjs.org/docs/app/api-reference/adapters/runtime-integration)):

> The Deployment Adapter API is a **build-time** interface. It tells your
> platform what was built and how to route requests. **Runtime** behavior
> (request handling, streaming, caching) is handled by the Next.js server itself
> and by the cache interfaces `cacheHandler` and `cacheHandlers`.

So there are two independent things:

1. **Implementing a `NextAdapter`** — `modifyConfig` + `onBuildComplete`.
   cdk-nextjs **already does this** (`src/adapter/adapter.mts`). Nothing to
   change here.
2. **Invoking build output entrypoints** instead of running `node server.js` —
   the subject of this plan.

Nothing in the docs deprecates `output: "standalone"`. Entrypoint invocation is
the supported path for a deployment platform and is what unlocks control over
dispatch (hence middleware on `_next/image`) and per-route splitting. Keep the
release notes precise about this: the claim is "cdk-nextjs now serves requests
through the adapter entrypoints", not "cdk-nextjs now uses the adapters API",
which has been true for a while.

## Spike 0 — packaging (before any Phase 3 code)

**Question:** can the runtime asset fit in a zip Lambda, or must it stay a
container image?

Zip Lambdas cap at **250 MB unzipped**. The entrypoints `require`
`next/dist/...` at runtime, so the `next` runtime closure ships with them.

Measure, from `examples/app-playground` after a real build:

1. Dump `ctx.outputs` to JSON from `onBuildComplete` (`src/adapter/adapter.mts:34`).
2. For `appPages`, `appRoutes`, `pages`, `pagesApi`, `middleware`: record
   `filePath` and every key of `assets`.
3. `du -sh` the union of `assets` values plus the entrypoint files.
4. Answer specifically: **does `assets` include the `next` package itself**, or
   only app code and static deps? If not, the runtime needs
   `.next/standalone/node_modules` or an equivalent traced closure alongside it,
   and the number changes a lot.

**Decision rule:**

- Comfortably under ~200 MB unzipped → **zip Lambda**. Full win: no Docker for
  Functions, `awslambda.streamifyResponse` for real Lambda response streaming,
  glibc `sharp` only.
- Over, or close → **keep a container image**, but rebase on
  `public.ecr.aws/docker/library/node:24` (glibc, not alpine) and drop Lambda
  Web Adapter for the Lambda Node runtime interface client. Still deletes LWA and
  the musl `sharp` path; loses the "no Docker required" headline.

Record the measured numbers in this file before starting Phase 3, and do not put
"no Docker required" in release notes until it is settled.

## Phase 1 — middleware runner (`src/middleware/`)

This is now narrowly scoped: it is the `invokeMiddleware` callback that
`resolveRoutes()` calls (Phase 2), nothing more.

**Build side**, in `onBuildComplete`:

- If `ctx.outputs.middleware` exists with `runtime !== "nodejs"`, **throw with a
  clear message**. Edge is
  [deprecated](https://nextjs.org/docs/messages/edge-runtime-deprecated) and
  Next 16's `proxy.ts` is always Node. Do not carry an edge code path,
  `globalThis._ENTRIES`, or `edgeRuntime` handling.
- Copy `middleware.filePath` and every `assets` entry at its repo-root-relative
  key (keys are relative paths, values absolute).
- Persist `config.matchers` and `config.env`.

**Runtime side:** invoke the Node entrypoint signature
`handler(req: IncomingMessage, res: ServerResponse, ctx)` and translate the
`x-middleware-next` / `x-middleware-rewrite` / `x-middleware-request-*` response
headers into whatever shape `resolveRoutes`'s `invokeMiddleware` expects. That
header protocol is the part most likely to be subtly wrong — unit-test it
directly.

Matcher evaluation: `resolveRoutes` may handle matcher gating itself given
`routes: routing`. **Verify before writing a matcher evaluator** — if it does,
this phase is only the invocation plus header translation. If it does not, match
on `matchers[].sourceRegex` honouring `has`/`missing`, and respect the injected
`missing` rule for `x-prerender-revalidate` or ISR revalidation requests will be
intercepted by user middleware.

## Phase 2 — dispatch via `@next/routing`

**Do not hand-write a router.** `@next/routing` is first-party, published, zero
dependencies, versioned in lockstep with Next (`16.3.5` exists on npm today).

```ts
import { resolveRoutes } from '@next/routing'

const result = await resolveRoutes({
  url: new URL(requestUrl),
  buildId,
  basePath: config.basePath || '',
  i18n: config.i18n,
  headers: new Headers(requestHeaders),
  requestBody,           // ReadableStream
  pathnames,             // pages+pagesApi+appPages+appRoutes+staticFiles pathnames
  routes: routing,       // ctx.routing from onBuildComplete
  invokeMiddleware: async (ctx) => { /* Phase 1 */ },
})
```

It returns `middlewareResponded`, `externalRewrite`, `redirect`,
`resolvedPathname` (the *template*, e.g. `/blog/[slug]`), `resolvedQuery`,
`invocationTarget` (the concrete pathname/query to invoke), `resolvedHeaders`,
`status`, and `routeMatches`.

That collapses most of what an earlier draft scoped as hand-written work:
locale normalization, `_next/data` normalization, `.rsc` suffixes, `basePath`,
rewrites/redirects/headers ordering, and dynamic param extraction. Remaining
work in this phase:

- Persist `ctx.routing` + the `pathnames` list into the runtime asset at build
  time.
- Map `resolvedPathname` → the right entrypoint `filePath`, and handle each
  non-entrypoint outcome (`redirect`, `externalRewrite`, `middlewareResponded`,
  `staticFiles` → S3/CloudFront).
- Route `_next/image` to `src/image-optimization/`. It is **not** an adapter
  output type — `AdapterOutputs` has no image optimizer member — so it is
  permanently our own code, reached through dispatch *after* middleware. That is
  the fix for the problem that started this whole line of work.
- Add `@next/routing` as a dependency and decide its version pinning relative to
  `next`. Lockstep versioning means a `next` bump likely needs a matching bump.

**Tests:** commit `routing` + `outputs` JSON from a few fixture builds
(app-playground, an i18n app, a `basePath` app) and assert dispatch decisions for
synthetic URLs. Pure unit tests, no AWS.

## Phase 3 — one runtime, two thin shells

One asset: all Node entrypoints, the union of their `assets`, the middleware
runner, the image handler, the dispatcher. One `handleRequest(req, res)` core,
wrapped by two shells:

- **Lambda** handler (Functions types) — `streamifyResponse` if Spike 0 says zip.
- **HTTP server** (Containers types) — same core behind `node:http`.

Invoke entrypoints as `handler(req, res, { waitUntil, requestMeta })`.

**Documented `requestMeta` fields** (from
[Invoking Entrypoints](https://nextjs.org/docs/app/api-reference/adapters/invoking-entrypoints)):

- `relativeProjectDir` — "Relative path from `process.cwd()` to the Next.js
  project directory." The in-Lambda layout is load-bearing; pin it and assert it.
- `hostname` — used by route handlers building absolute URLs.
- `revalidate` — "internal revalidate function to avoid revalidating over the
  network". Back it with the existing S3/DynamoDB path.
- `render404` — for pages-router `notFound: true`.

**`ctx.waitUntil`** keeps the function alive after the response so background
revalidation completes. Wire it to the Lambda invocation lifecycle.

**`requestMeta.onCacheEntryV2`** (documented, set via `addRequestMeta`) fires
when a cache entry is generated or looked up, on the instance that handled the
request. The docs name it as the hook for propagating cache updates to shared
platform storage. Evaluate it against what `src/adapter/cache-handler.ts`
already does via `cacheHandler` — they overlap, and the answer may be that the
existing handler is sufficient. Decide explicitly rather than wiring both.

**Do not set `minimalMode`.** See the note below. Absent is correct.

**PPR resume protocol** — a real adapter responsibility, documented:
`outputs.prerenders[].pprChain.headers` contains `{ 'next-resume': '1' }`. When a
PPR route has a cached static shell, set those headers on the internal request,
send it as a **POST** with `postponedState` as the body, and the handler renders
only the deferred Suspense boundaries and streams. `next start` does shell +
dynamic in one pass automatically; adapters must implement the chain. See
[Implementing PPR in an Adapter](https://nextjs.org/docs/app/api-reference/adapters/implementing-ppr-in-an-adapter).

**`output: "standalone"`** in `modifyConfig` (`src/adapter/adapter.mts:19`):
keep it until Spike 0 confirms `assets` is a complete closure. Once all four
types invoke entrypoints and the closure is proven, it can go — and with it the
alpine standalone server and the `@img/sharp-linuxmusl-*` download
(`src/nextjs-build/nextjs-build.ts:403`).

**Sequencing on the branch:** do the Functions types first — that is where the
benefit is concentrated. Containers second, before the branch merges, so there
is one request path proven rather than two. Both must land before the PR opens
against `main`; unlike an incremental-release plan, there is no "ship
Functions-only, follow up on Containers later" option here — the branch isn't
done, and doesn't merge, until all four types are on the new runtime. If
Containers work turns out to be substantially harder than Functions, that's a
timeline/scope conversation to have explicitly, not a default fallback.

## Phase 4 — splitting (NOT in this release)

Per-output packaging driven by `config.maxDuration` / `preferredRegion`, with
routing at CloudFront / API Gateway. If Phase 3 keeps dispatch separate from
invocation this is a packaging change plus distribution wiring, with no runtime
rework — which is exactly why it need not gate the release.

## Testing: use the official adapter harness as the primary gate

Next.js ships a
[compatibility test harness](https://nextjs.org/docs/app/api-reference/adapters/testing-adapters)
that runs **vercel/next.js's own e2e suite against a real deployment**. This is a
far better gate than any fixture app we would write, and it is the single most
valuable item in this plan — more so now that there's no env-var-toggled
byte-diff oracle to lean on mid-development.

Wiring: three executables in `scripts/`, pointed at by env vars —

- `NEXT_TEST_DEPLOY_SCRIPT_PATH` → builds and deploys the harness's isolated
  temp app; **prints only the deployment URL to stdout**, diagnostics to stderr,
  non-zero exit on failure. Runs with `cwd` set to the temp app.
- `NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH` → must print lines starting `BUILD_ID:`,
  `DEPLOYMENT_ID:`, `NEXT_SUPPORTS_IMMUTABLE_ASSETS:`, then any logs. Separate
  process, so persist those to a file (e.g. `.adapter-build.log`) from the deploy
  script and replay them here.
- `NEXT_TEST_CLEANUP_SCRIPT_PATH` → tears the stack down. **Not optional for us**
  — every run deploys real AWS resources, so a missing or failing cleanup leaks
  stacks and costs money. Make it idempotent and verify it runs on test failure.

Harness run config from the docs: `NEXT_TEST_MODE=deploy`,
`NEXT_EXTERNAL_TESTS_FILTERS=test/deploy-tests-manifest.json`, `ADAPTER_DIR`,
`NEXT_ADAPTER_PATH` pointing at the built adapter, then
`node run-tests.js --timings -g <n>/16 -c 2 --type e2e` from a next.js checkout.
The example workflow shards 16 ways with a 60-minute timeout per shard.

Cost and time are the real constraints here: 16 shards each deploying a CDK
stack is not a per-PR gate. Run it `workflow_dispatch` + nightly against the
release branch while the branch is under development, and keep
`examples/e2e-tests/` as the fast per-commit check on the branch itself. Both
must be green before the branch merges to `main`.

The existing suite stays, but do not trust it as the sole gate for a runtime
rewrite: it asserts status codes and one content-type, and **it cannot see the
class of bug that produced this work** — a broken `sharp` returning HTTP 200
with unoptimized original bytes, through four green e2e jobs. Add byte- and
header-level assertions (`etag` shape: Next.js uses sha256/base64url while S3
uses MD5 — that difference is what caught it), plus a middleware e2e proving a
403 or redirect on `_next/image`.

Also still absent: the first CDK assertion test in `test/` (only `tsconfig.json`
today). Blocked on `NextjsBuild` running `next build` in its constructor — needs
`skipBuild: true` plus a committed fixture `.next`.

## On `minimalMode`: undocumented internal, do not set it

An earlier draft said to "set `minimalMode: false` deliberately". That was
overstated, and the field is not part of the documented API.

- The
  [Invoking Entrypoints](https://nextjs.org/docs/app/api-reference/adapters/invoking-entrypoints)
  page lists only `relativeProjectDir`, `hostname`, `revalidate`, and `render404`
  ("Some of the supported fields are..."). `minimalMode` is not mentioned.
- It is an internal `RequestMeta` field. From
  `next/dist/server/request-meta.d.ts:252-255`: *"Whether server is in minimal
  mode (this will be replaced with more specific flags in future)"* — explicitly
  marked for replacement.
- Entrypoints read it via `getRequestMeta(req, 'minimalMode')`
  (`next/dist/build/templates/app-page-runtime.js:160`,
  `app-route.js:178`) and branch on it in ~20 places, including the one that
  matters: `getIncrementalCache(req, nextConfig, prerenderManifest, isMinimalMode)`
  at `app-page-runtime.js:504`.

Because it is read with `Boolean(getRequestMeta(...))`, **absent means false**,
which is the non-minimal path that keeps the incremental cache inside the
entrypoint and therefore keeps `src/adapter/cache-handler.ts` working. That
matches what Runtime Integration documents as the intended split: the adapter is
build-time, caching is `cacheHandler`'s job. So there is no decision to make —
just do not pass the field, and do not build anything that depends on its
semantics.

## Open questions

1. **Spike 0's answer** — zip or container. Everything downstream of "no Docker
   required" depends on it.
2. Does `outputs.*.assets` include the `next` runtime closure, or only app code?
3. Does `resolveRoutes` gate middleware by `config.matchers` itself, or must the
   `invokeMiddleware` callback do it?
4. Cold-start cost of one Lambda holding N entrypoints. Eagerly `require`ing all
   of them makes every cold start pay for the whole app — lazy-require per
   dispatch decision, and measure.
5. `onCacheEntryV2` versus the existing `cacheHandler`: which owns propagation to
   S3/DynamoDB? Pick one.
6. `@next/routing` version pinning against `next`.
7. What happens to `docs/plans/phase-0-image-function-opt-in.md`'s
   `CDK_NEXTJS_EXPERIMENTAL_DEDICATED_IMAGE_FUNCTION` flag and the dedicated
   image Lambda it introduced. This plan's dispatcher makes that Lambda
   unnecessary (`_next/image` is reached through dispatch after middleware on
   every `NextjsType`), so the flag, the dedicated Lambda, and the branching it
   caused in `suppress-nags.ts`/`NextjsApi` are candidates for deletion in the
   same PR rather than being carried forward.

## Exit criteria for merging to `main`

- Official harness green (or every exclusion documented with a reason).
- All existing e2e suites green, including `streaming`, `isr`, `revalidation`,
  `server-actions`, on **all four** `NextjsType`s — not a subset.
- Middleware e2e proving interception on `_next/image`.
- Cold-start measurement on a non-trivial app versus the LWA path.
- `docs/breaking-changes.md` covering the removed `dedicatedImageFunction` prop
  and — if Functions stop being container images — the
  `nextjsFunctionsProps.dockerImageFunctionProps` override keys, which become
  meaningless. That is a real breaking change for anyone using them.
- No env var, flag, or dead code path left behind from development. If Spike 0
  or an earlier phase produced throwaway scaffolding, it is deleted before the
  PR opens, not carried into `main` "to remove later."
