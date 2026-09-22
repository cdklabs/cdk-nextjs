# Adapter runtime: implementation progress

Running log for the branch implementing `docs/plans/adapter-runtime-release.md`.

**Purpose.** The plan says what to build; this file says what actually happened.
It exists so a session with zero prior context — or one resuming after a
compaction — can pick up the _facts_ without reading a transcript. Write for that
reader.

**How to maintain it.** Append a section at every commit boundary in the plan's
"Commit order". Never rewrite history here; if an earlier entry turns out wrong,
add a later entry correcting it and say so. Keep entries short and factual — this
is not a narrative.

Each entry records:

- **Landed** — what the commit does, and its SHA once committed.
- **Decisions** — choices made that the plan left open, and the reason. A
  decision that contradicts the plan's "Decisions (do not relitigate)" section
  needs an explicit note saying why, and should have been raised with the user
  first.
- **Measured** — any number the plan asks to be recorded (packaging sizes,
  cold-start timings, response byte diffs). Include the command used, so it can
  be re-run.
- **Verified vs. assumed** — which behavior a test actually proves, and which is
  currently taken on faith. Be honest here; this is the field that decays fastest
  under compaction.
- **Deferred / open** — anything left undone, with enough detail to resume it.

## Environment

AWS testing uses:

```bash
export AWS_PROFILE="stickb-cdk-nextjs"
export AWS_REGION="us-east-1"
```

Build/verify commands (see `CLAUDE.md`): `pnpm compile`, `pnpm jest <file>`,
`pnpm eslint`, `pnpm bundle`. **Do not run `pnpm build`** — docgen hangs on
`node_modules`; CI regenerates `API.md`. Run `pnpm projen` after editing
`.projenrc.ts`.

The four deployed stacks `main-glbl-fns`, `main-rgnl-fns`, `main-glbl-cntnrs`,
`main-rgnl-cntrs` run the pre-branch path and are the byte-diff oracle. They stay
up for the duration of this work — do not delete or modify them.

## Status

| Plan step                                                          | State                                                                                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 — build outputs (`onBuildComplete`)                              | done                                                                                                                                                                     |
| 2 — dispatch via `@next/routing`                                   | done                                                                                                                                                                     |
| 3 — middleware runner                                              | done                                                                                                                                                                     |
| 4 — runtime core + two shells                                      | done                                                                                                                                                                     |
| 5 — wire constructs, Functions to zip, Containers Dockerfiles      | done                                                                                                                                                                     |
| 6 — delete `output: "standalone"` + dedicated image function       | done                                                                                                                                                                     |
| 7 — splitting (`functionGroups`)                                   | done                                                                                                                                                                     |
| 8 — tests, docs, breaking-changes                                  | done, with three exit criteria unmet (see step 8 entry)                                                                                                                  |
| 9 — PPR: `cacheComponents` migration of `app-playground` + PPR e2e | done (clears exit criterion 1 of step 8's three)                                                                                                                         |
| 10 — official Next.js test harness (plumbing + small slice)        | done; one shared warmed `NextjsGlobalFunctions` stack (10b, 10c). Step 8's exit criterion 2 **met** in 10c: two next.js e2e files pass against a real deployment, exit 0 |

Exit criteria are tracked in the plan, not duplicated here. Record against them
in the final entry.

## Log

<!-- Append entries below. Newest last. -->

## Step 1 — build outputs (`onBuildComplete`)

**Landed** — commit `feat: stage the adapter manifest and deployment root at build time` (referenced by subject, not SHA: this entry ships inside that commit, so it cannot name its own hash)

- `src/runtime/manifest.ts` — the build → runtime → synth contract, exactly the
  shape in the plan's "Artifact contract". Deliberately **not** exported from
  `src/index.ts`, so it is exempt from JSII restrictions. Also holds the four
  path constants (`cdk-nextjs-adapter`, `app`, `manifest.json`,
  `cdk-nextjs-runtime`).
- `src/adapter/build-outputs.ts` — `buildAdapterManifest(ctx)` (pure) and
  `writeBuildOutputs(ctx)` (does the I/O). The split exists so the fixtures can
  be tested without a real filesystem. Covers the plan's jobs 1–6; job 7
  (init-cache seeding) is untouched. Also emits the `maxDuration` /
  `preferredRegion` warnings.
- `src/adapter/adapter.mts` — calls `writeBuildOutputs` at the top of
  `onBuildComplete` and logs the staged file count / bytes / entrypoint count.
  `modifyConfig` **still sets `output: "standalone"`**; both trees are produced
  until step 6. Nothing reads the manifest yet.
- `scripts/capture-adapter-fixture.mjs` — regenerates the fixtures from a real
  `next build`. Kept (not throwaway) because `ctx.routing`/`ctx.outputs` are
  Next.js's shapes and change between minors.
- `src/adapter/__fixtures__/{app-playground,app-playground-base-path,pages-i18n}.json`
  — real captures, trimmed and with absolute paths rewritten to `/repo`.
- `examples/pages-i18n/` — new minimal Pages Router example. Its only job is to
  produce the `outputs.pages` / `outputs.pagesApi` / `config.i18n` shapes, which
  an App Router build cannot: Next.js rejects `i18n` when an `app/` directory
  exists. Not deployed by any CDK example, not in the e2e suite.
- `src/adapter/build-outputs.test.ts` — 29 tests.

**Decisions**

1. **Symlinks in `assets` are recreated as symlinks, never dereferenced.** Under
   pnpm, `assets` values are frequently _directory_ symlinks into the store
   (21 of 738 keys for app-playground, including `app-playground/node_modules/next`
   → the whole package). `copyFile` fails on those with `ENOTSUP`, and Next's own
   `copyTracedFiles` (`node_modules/next/dist/build/utils.js`, ~1012–1038) does
   `readlink` → `symlink` with a Windows junction fallback, so preserving them is
   the behavior-matching choice as well as the small one. `stageFiles` stages
   regular files first, then links, skipping any link whose destination is
   already real content, and dereferences (`cp -R --dereference`) only a link
   that resolves **outside** the staging root — those would dangle in Lambda.
2. **`assetsHashes` is used only as a conflict check, not as a staged-content
   integrity assertion.** The plan's job 3 asks for both. The integrity half is
   not implementable: the map mixes two hash schemes. `pushAsset` entries are
   `sha256(outputHashSalt + "file:" + content)` (verified reproducible for
   `.next/BUILD_ID`), but the large majority come from `loadNFT`, which copies
   NFT's own `fileHashes[i]` — a different, unsalted scheme that does not
   reproduce under either formula. Recorded as an explicit omission, not a
   silent skip. The conflict check (two outputs → one key → different hashes →
   throw) is implemented and tested.
3. **`entrypoints` is keyed by `output.pathname` verbatim, including `basePath`.**
   `pathname` is basePath-prefixed (`/prod/api/health`) while `id` is not
   (`/api/health`). The plan's step 2 passes `basePath` to `resolveRoutes`
   separately; whether `resolvedPathname` comes back prefixed is the open
   question that decides if this key needs stripping. Deliberately left prefixed
   for now because that is what the build reports; **step 2 must confirm it.**
4. **Fixtures are trimmed and human-readable, not faithful blobs.** A raw
   app-playground capture is ~9 MB, nearly all repeated `node_modules` paths in
   per-output `assets` maps. The script keeps a curated route allowlist, every
   non-`node_modules` asset key, and 8 `node_modules` keys per output, and
   records the trim in a `_meta` block. Chosen for reviewability of the diff.
5. **The staged tree is `rm -rf`'d before each build.** A previous build's tree
   is never additive: a deleted route leaves an orphan entrypoint and a renamed
   chunk leaves dead bytes inside the 250 MB budget.

**Measured**

| What                    | Value                                                      | Command                                                                                                                  |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| app-playground staged   | 738 files, 31.5 MB counted, 32 MB on disk, 122 entrypoints | `node scripts/capture-adapter-fixture.mjs app-playground`; `du -sh examples/app-playground/.next/cdk-nextjs-adapter/app` |
| same tree, dereferenced | 96 MB (3.0×)                                               | `du -shL examples/app-playground/.next/cdk-nextjs-adapter/app`                                                           |
| symlinks in that tree   | 21                                                         | `find . -type l \| wc -l` in the staged tree                                                                             |
| pages-i18n staged       | 218 files, 6.7 MB, 18 entrypoints                          | `node scripts/capture-adapter-fixture.mjs pages-i18n`                                                                    |
| fixture sizes           | 227 KB / 228 KB / 168 KB                                   | `ls -l src/adapter/__fixtures__`                                                                                         |
| tests                   | 29 passed, 98.7% statement coverage of `build-outputs.ts`  | `pnpm jest src/adapter/build-outputs.test.ts`                                                                            |

Both `.next/standalone` and the new tree are produced right now, so neither
number is the final packaged size. The zip-vs-image comparison the plan asks for
belongs to step 5.

Correction to an earlier in-session figure: the dereferenced cost was briefly
recorded as 430 MB. The reproducible number is 96 MB (`du -shL`), still under the
250 MB cap for this app. The argument for preserving symlinks rests on `ENOTSUP`
and on matching `copyTracedFiles`, not on breaching the cap.

**Verified vs. assumed**

Verified by test or direct measurement:

- The manifest produced from all three fixtures: version/buildId/
  `relativeProjectDir`, the four config fields, `routing` preserved verbatim
  (including `middlewareMatchers`), one entrypoint per invocable `pathname`, all
  entrypoint `filePath`s present in the staging plan, sorted-unique `pathnames`
  and `staticFiles`, and every staging key relative, POSIX, and inside the root.
- Staging for real on a tmpdir repo: a copied file, a preserved relative
  symlink, a dereferenced escaping symlink, `.env` + `.env.production` staged,
  `manifest.json` written and matching the returned manifest, and a stale file
  from a prior run removed.
- Every throw: edge runtime, hash conflict, `..` key, `cdk-nextjs-runtime/` key,
  two outputs claiming one pathname.
- The `maxDuration` warning fires exactly once from a real build (`pages-i18n`).
- The `assets` union is a complete standalone replacement, checked directly
  against the still-present standalone output: all 17 `requiredServerFiles.files`
  are in the union, and a sampled `page.js.nft.json`'s 167 entries are 100%
  covered.
- `next` 16.3.5 supplies `ctx.routing.middlewareMatchers`; 16.2.10 does not.
  `examples/node_modules` was stale at 16.2.10 and needed
  `pnpm install --frozen-lockfile` before the first capture was trustworthy.

Assumed, not yet proven:

- That a Lambda can actually boot from this tree. Nothing loads the manifest or
  requires an entrypoint yet; steps 2–4 are the first real test.
- That the three standalone-only contributions (its generated `server.js`, its
  root `package.json` shim, `.env`/`.env.production`) are the complete gap. Only
  the env files are handled here, because the other two are replaced by our own
  runtime in step 4.
- Byte-for-byte response parity with the deployed oracle stacks — step 5+.

**Deferred / open**

- **Step 2 must decide the basePath question** in decision 3 above: compare
  `resolveRoutes`' `resolvedPathname` against the basePath-prefixed
  `manifest.entrypoints` keys using the `app-playground-base-path` fixture. If it
  returns unprefixed templates, either the keys get stripped at build time or the
  lookup strips at runtime — pick one and record it.
- `routing.shouldNormalizeNextData` is `false` in the `pages-i18n` capture even
  though that build emits `/_next/data/<buildId>/…json` outputs, which are
  separate `entrypoints` keys pointing at the same file. Step 2 should confirm
  `resolveRoutes` handles those without our help.
- Pages Router `sourcePage` has no leading slash (`blog/[slug]`), unlike App
  Router (`/context/[categorySlug]/page`). Only affects error-message wording
  today.
- `preferredRegion` warning path and the "link destination already staged as real
  content" branch of `stageFiles` are the only uncovered lines; no fixture
  produces either.
- Fixtures are POSIX-keyed with a `/repo` placeholder, so the unit tests assume a
  POSIX `path.relative`. They would need adjusting to run on Windows; CI is
  Linux/macOS.

## Step 2 — dispatch via `@next/routing`

**Landed** — commit `feat: resolve requests through @next/routing` (referenced by
subject, not SHA: this entry ships inside that commit)

- `.projenrc.ts` — added `@next/routing@16.3.5` to `devDeps`, exact-pinned with a
  comment explaining why. `pnpm projen` regenerated `package.json` /
  `.projen/deps.json` / `.projen/tasks.json` / `pnpm-lock.yaml`.
- `src/runtime/dispatch.ts` — `Dispatcher` / `createDispatcher`. Takes a
  `DispatchRequest` (`url`, `headers`, `body` stream), calls
  `resolveRoutes`, and returns a `DispatchResult` discriminated union:
  `entrypoint`, `static-file`, `image-optimization`, `redirect`,
  `external-rewrite`, `middleware-responded`, `response`, `not-found`. Pure
  decision-making — no filesystem, no `require` of any entrypoint, no `Response`
  construction. All of that is step 4.
- `src/adapter/build-outputs.ts` — `addPrerenderTemplates`, which adds dynamic
  _prerender_ templates to `entrypoints`/`pathnames`. See decision 2.
- `src/runtime/manifest.ts` — doc-only: `entrypoints` and `pathnames` now say what
  they contain and that keys need no normalization.
- `scripts/capture-adapter-fixture.mjs` — dynamic prerender templates are now
  never trimmed away (the `MAX_PRERENDERS` cap applies to concrete prerenders
  only), and a `--reuse-capture` flag re-trims the previous dump without a
  ~2 minute rebuild. All three fixtures regenerated; buildIds changed, so any
  hard-coded buildId in a future test will break — read it off the manifest.
- `src/runtime/dispatch.test.ts` — 22 tests. `src/adapter/build-outputs.test.ts`
  grew to 32.

**Decisions**

1. **Nothing is normalized between the manifest and `resolveRoutes`.** Step 1's
   open basePath question is closed: `resolvedPathname` comes back **both
   basePath- and locale-prefixed**, matching `manifest.entrypoints` keys exactly
   (`/prod/isr/[id]`, `/fr/blog/[slug]`). The lookup is a plain object index. Step
   1 decision 3 was correct as written; no stripping anywhere.
2. **Dynamic prerender templates are added to `entrypoints` and `pathnames`, and
   concrete prerenders are not.** `resolveRoutes` can only match a pathname that
   is in `pathnames`, and the plan defined `pathnames` as routes + staticFiles.
   That leaves Pages Router ISR data URLs unresolved:
   `/_next/data/<buildId>/fr/blog/hello.json` needs
   `/_next/data/<buildId>/fr/blog/[slug].json` listed, and that pathname exists
   only as a `prerenders` entry. `next start` serves those URLs, so omitting them
   is a behavior difference. The owner comes from `prerender.route` (unprefixed,
   unlocalized — hence a `basePath + route` then bare `route` ladder); locale
   variants share a `filePath`, so any locale's entrypoint is the right target.
   Adding _concrete_ prerender pathnames instead was measured to be actively
   wrong: with `/isr/1` in `pathnames`, `/isr/1` resolves to itself rather than to
   `/isr/[id]` and the `nxtPid` query param is lost. An orphan template warns
   rather than throws — an unmapped template degrades one URL shape to a 404,
   which is the status quo without the feature, whereas a throw would break builds
   on an output shape a future `next` minor might introduce.
3. **Dispatch captures `MiddlewareResult.requestHeaders` itself.**
   `resolveRoutes` **drops** them: it neither returns them in
   `ResolveRoutesResult` nor mutates the `headers` object it was handed (verified
   by probe). Left alone that silently breaks
   `NextResponse.next({ request: { headers } })`. The `invokeMiddleware` wrapper
   stashes them and every result carries `requestHeaders`.
4. **`resolvedHeaders` is treated strictly as response headers, and a redirect is
   normalized from two shapes.** Every redirect observed — the i18n default-locale
   308, the `trailingSlash` 308, a middleware `NextResponse.redirect()`, and
   `next.config` `redirects()` (which compile to routes carrying
   `headers: { Location }` + `status`) — arrives as a bare `status` with
   `location` in `resolvedHeaders`, never as `ResolveRoutesResult.redirect`.
   `toRedirect` handles both; it is exported solely so the today-unreachable
   documented branch is still tested.
5. **The 404 target is resolved once at construction, not per request.**
   `Dispatcher.notFound` is an entrypoint (`/_not-found` for App Router, `/_error`
   for Pages), else the prerendered `/404`, else `none`. Locale-aware selection
   among `/fr/404` etc. and honoring `notFound()` thrown by a route are step 4's
   job; dispatch only reports the candidate.
6. **Constructing a `Dispatcher` throws if the build has middleware and no
   `invokeMiddleware` was supplied.** Silently skipping middleware would change
   auth and rewrite behavior, which is the worst possible failure mode to make
   quiet.

**Measured**

| What                             | Value                     | Command                                       |
| -------------------------------- | ------------------------- | --------------------------------------------- |
| tests                            | 112 passed, 8 suites      | `pnpm jest`                                   |
| `dispatch.ts` coverage           | 99.2% stmts, 95.7% branch | `pnpm jest src/runtime/dispatch.test.ts`      |
| `build-outputs.ts` coverage      | 98.9% stmts, 94.0% branch | `pnpm jest src/adapter/build-outputs.test.ts` |
| fixture sizes after regeneration | 229 KB / 230 KB / 168 KB  | `ls -l src/adapter/__fixtures__`              |

**Verified vs. assumed**

Verified by test against the real captured manifests:

- basePath-prefixed entrypoint keys match `resolvedPathname` with no
  normalization, and an unprefixed path under a basePath app is a 404.
- `/isr/1` → template `/isr/[id]`, `invocationTarget` `/isr/1`, `nxtPid: "1"` in
  both `query` and `routeMatches`.
- App Router route handler, Pages Router page and API route each resolve to the
  right `type`.
- `/_next/data/<buildId>/fr/blog/hello.json` → template entrypoint (decision 2).
- A `/_next/static/...` asset → `static-file` carrying
  `cache-control: public,max-age=31536000,immutable` from the `onMatch` rule.
- `/_next/image` → `image-optimization`, with and without basePath.
- Trailing-slash 308, i18n default-locale 308 to `/en-US`, and a route forcing a
  bare `status: 403` with a header.
- Middleware: `bodySent` → `middleware-responded`; `redirect` → normalized
  `redirect`; internal `rewrite` → the rewritten entrypoint; external `rewrite` →
  `external-rewrite`; `requestHeaders` forwarded; `responseHeaders` returned;
  caller headers passed through when middleware sets none; constructor throws
  without a runner.
- 404 target per router flavor, plus the `/404` and `none` fallbacks.

Assumed, not yet proven:

- That a real middleware bundle can be invoked to produce the `MiddlewareResult`
  these tests hand-write. That is step 3.
- That `invocationTarget` + `routeMatches` + `query` are sufficient to render a
  route correctly. Step 4 is the first thing that actually renders.
- Everything about response bodies, streaming, and `waitUntil`. Dispatch never
  builds a `Response`.

**Deferred / open**

- `_next/image` is matched by exact pathname (`basePath + "/_next/image"`). If
  `trailingSlash: true` rewrites that URL shape, step 4 must confirm the
  comparison still holds; no fixture covers it.
- The `result.invocationTarget ?? { … }` fallback in `dispatch` is the only
  uncovered line in the file. It is defensive against a `next` shape change and
  is unreachable today — `invocationTarget` is always present alongside
  `resolvedPathname`.
- `Route.status` on a matched route is carried through as `DispatchResult.status`
  on `entrypoint` and `static-file` results, but nothing consumes it yet. Step 4
  must apply it to the outgoing response.
- `routing.rsc` is in the manifest (part of `ctx.routing` verbatim) and is
  **not** in `ResolveRoutesParams["routes"]`. It is passed through the cast and
  presumably ignored. If RSC request handling turns out to need it, step 4 owns
  reading it directly.
- `shouldNormalizeNextData` is `false` in the pages-i18n capture even though the
  build emits `/_next/data/…` outputs, and dispatch still resolves those URLs
  correctly — the step 1 open question is answered: `resolveRoutes` needs no help
  there.
- `src/runtime/dispatch.ts` is JSII-compiled into `lib/` even though it is only
  ever consumed through the esbuild bundle (step 5 adds that bundle). The compiled
  copy's `require("@next/routing")` would fail at runtime, since the package is a
  devDependency. Harmless as long as nothing imports `lib/runtime/dispatch.js`,
  which mirrors how `src/adapter/cache-handler.ts` already works — but it is a
  trap worth remembering.

## Step 3 — middleware runner

**Landed** — commit `feat: run built middleware through the routing callback`
(referenced by subject, not SHA: this entry ships inside that commit)

- `src/runtime/middleware.ts` — `MiddlewareRunner` / `createMiddlewareRunner`.
  `invokerFor(perRequest)` returns the `MiddlewareInvoker` that
  `Dispatcher.dispatch` hands to `resolveRoutes`: it builds a `Request`, calls the
  built handler, and returns `responseToMiddlewareResult(response, headers, url)`.
  That is the whole file. No matcher evaluation (`resolveRoutes` gates from
  `routing.middlewareMatchers`, which already carries the injected
  `x-prerender-revalidate` `missing` rule) and no hand-written `x-middleware-*`
  parsing, per the plan.
- `loadMiddlewareHandler` — `createRequire(absolute)(absolute)` then **`await`**
  the result, and pull `.handler` off it. Two throws with actionable text: the
  module not loading ("deployment package is incomplete") and no `handler` export
  ("Next.js changed the shape of `next/dist/build/templates/middleware.js`").
- `src/runtime/dispatch.ts` — `DispatchRequest` gained a required `method`, and
  `MiddlewareInvoker` now takes `MiddlewareContext & { method: string }`. See
  decision 1. `dispatch()` spreads the method into the invoker call; nothing else
  changed.
- `src/runtime/middleware.test.ts` — 16 tests. `src/runtime/dispatch.test.ts`'s
  `request()` helper supplies `method: "GET"`.

**Decisions**

1. **`MiddlewareInvoker` carries the request method; `MiddlewareContext` does
   not.** `@next/routing` passes middleware only `{ url, headers, requestBody }`
   because _routing_ never needs a method — but middleware does
   (`if (request.method === "POST")`), and `new Request(url)` defaults to GET.
   Dispatch adds it from the `DispatchRequest` it already has, which is why
   `DispatchRequest.method` became required in this step rather than step 2.
2. **The body stream is attached only for methods that can have one**
   (anything but GET/HEAD), with `duplex: "half"`. `new Request(url, { body })`
   throws outright for GET/HEAD, and undici requires `duplex` for any stream body
   — it is absent from TypeScript's `RequestInit`, hence the one cast in the file.
3. **`await` the `require()` result.** Turbopack emits middleware as an _async
   module_: `module.exports` is a Promise whose `Symbol(turbopack exports)` keys
   are invisible to `Object.keys`, so a synchronous `require(...).handler` is
   `undefined` and the error looks like a Next.js API change. `await` covers both
   that and the webpack/plain-CJS shape. Verified against the real
   `examples/app-playground/.next/server/middleware.js` and pinned by a test that
   writes `module.exports = Promise.resolve({ handler })`.
4. **The loaded handler is memoized on the runner as a `Promise`, and the invoker
   is created per request.** Loading the middleware bundle pulls in the app's
   whole middleware closure and is cold-start-expensive; holding the promise (not
   the resolved value) means concurrent first requests share one load.
   `waitUntil` / `signal` / `requestMeta` are per-request, so they live on
   `invokerFor(perRequest)` instead.
5. **A middleware throw is rethrown wrapped, never swallowed.** The wrapper adds
   the manifest `filePath` and `METHOD /pathname` and keeps the original as
   `cause`. `next start` 500s on a middleware throw; step 4 owns turning this into
   that response.
6. **`loadHandler` is an explicit option, not just a test seam.** It is also how
   step 4 can preload middleware during Lambda init instead of on first request.
7. **`config.env` on the middleware output stays unused.** The plan says
   `__NEXT_BASE_PATH` and friends are DefinePlugin-inlined, and the real capture
   confirms nodejs middleware has no `config.env` at all. `manifest.middleware.env`
   is therefore dead weight today; left in place rather than churning the manifest
   shape, since edge middleware (if ever supported) would need it.

**Measured**

| What                     | Value                     | Command                                    |
| ------------------------ | ------------------------- | ------------------------------------------ |
| tests                    | 129 passed, 9 suites      | `pnpm jest`                                |
| `middleware.ts` coverage | 100% stmts, 100% branch   | `pnpm jest src/runtime/middleware.test.ts` |
| `dispatch.ts` coverage   | 99.2% stmts, 96.1% branch | `pnpm jest src/runtime/dispatch.test.ts`   |

**Verified vs. assumed**

Verified by test, through a **real** `Dispatcher` and real `@next/routing` (only
the handler itself is synthetic, so the `x-middleware-*` translation under test is
the shipped one):

- `x-middleware-next` → pass-through to the entrypoint;
  `x-middleware-override-headers` + `x-middleware-request-*` → forwarded
  `requestHeaders` (the end-to-end proof of step 2 decision 3); a plain response
  header → `responseHeaders`; internal `x-middleware-rewrite` → the rewritten
  entrypoint; external `x-middleware-rewrite` → `external-rewrite`; `location` +
  307 → `redirect`; no `x-middleware-next` → `middleware-responded`.
- Method, URL (including query) and caller headers reach the handler; GET/HEAD/`get`
  get `request.body === null`; POST gets the stream and reads back its bytes.
- `waitUntil` and `requestMeta` are passed straight through.
- One load across three requests and two invokers.
- Real module loading from a tmpdir: `exports.handler = …`,
  `module.exports = Promise.resolve({ handler })`, a missing file, and a module
  with no `handler`.

Verified out of band this session (not pinned by a committed test, because it
needs a real `next build` on disk):

- `examples/app-playground/.next/server/middleware.js` requires to a Promise whose
  resolved value is `{ default, handler }` with `handler.length === 2`.
- Invoking that real handler with `(new Request(url, { method, headers }),
{ waitUntil })` returned 200 with `x-middleware-next: 1`, `waitUntil` was called
  once, and `responseToMiddlewareResult` produced non-empty `requestHeaders` and
  empty `responseHeaders`. A POST with a `ReadableStream` body + `duplex: "half"`
  also worked.

New observation worth carrying into step 4: a **same-origin** `location` comes back
from `resolveRoutes` **relative** (`/login`), not as the absolute URL middleware
wrote. `DispatchRedirectResult.location` is therefore not always absolute.

Assumed, not yet proven:

- That `signal` is worth plumbing. `MiddlewarePerRequest.signal` exists and is
  forwarded, but nothing constructs one yet; Lambda has no client-disconnect
  signal to hook it to.
- Everything about the response side: nothing here builds the 500 for a middleware
  throw or streams a `middleware-responded` body. Step 4.

**Deferred / open**

- Edge middleware is rejected at build time, not here: `assertNodeRuntimes`
  includes `outputs.middleware` in its invocable list, so `runtime: "edge"`
  middleware throws in `buildAdapterManifest` before the runner ever sees it. No
  test asserts that specific case (the existing edge test uses an `appRoutes`
  output).
- `MiddlewareRunner` resolves `filePath` against an injected `root`. Step 4 must
  pass the staging root — `process.cwd()` in both shells, per step 1's layout —
  and step 5 must make sure the Dockerfile `WORKDIR` matches.
- The `middleware-responded` case returns no body from dispatch. The plan's
  step 4 design has the runner holding the `Response`; today `MiddlewareRunner`
  drops it after translation. Step 4 needs to capture it (the `bodySent` path),
  and this is the one place where step 3's surface is knowingly incomplete.

## Step 4 — runtime core + two shells

**Landed** — commit `feat: serve requests from one runtime core behind two shells`
(referenced by subject, not SHA: this entry ships inside that commit)

Nothing in the deployed stacks changes yet. This step builds the request path and
covers it with unit tests; step 5 is what makes a construct point at it.

- `src/runtime/http/request.ts` — `ShimIncomingMessage`, a synthesized
  `http.IncomingMessage` over a fake socket (lineage: `serverless-http`). Both
  shells use it, _including Containers_: handing the container path a real
  `IncomingMessage` would mean the container e2e suite proves nothing about the
  Lambda path.
- `src/runtime/http/response.ts` — `ShimServerResponse`, a `Readable` that emits a
  one-shot `"head"` event (status + flat headers + `set-cookie` array) on the first
  body byte, then the body. `asServerResponse()` is the cast boundary;
  `splitSetCookie()` splits a combined `set-cookie` without cutting an `Expires`
  comma. `addTrailers`/`assignSocket`/`writeContinue`/`writeEarlyHints` throw named
  errors rather than silently doing nothing.
- `src/runtime/http/sink.ts` — `ResponseSink` (`begin(head) → Writable`, optional
  `padEmptyBody`) and `pipeToSink(req, res, sink, { compress })`, which owns gzip.
- `src/runtime/core.ts` — `NextjsRuntime.handle(request, sink)`: absolute URL from
  the forwarded headers, body split, dispatch, then one case per
  `DispatchResult.kind` (entrypoint, static file, image optimization, redirect,
  external rewrite, middleware-responded, direct response, not-found).
  `loadRuntime(deploymentRoot)` reads the manifest, probes for the staged project,
  and `chdir`s into it.
- `src/runtime/deployment-root.ts` — `deploymentRootOf(shellDir)`: asserts the
  shell lives at `<deploymentRoot>/cdk-nextjs-runtime/` and returns the parent.
- `src/runtime/lambda.mts` — the Functions shell. `awslambda.streamifyResponse`,
  handling **both** event shapes: Function URL payload v2 (Global Functions) and
  API Gateway REST proxy (Regional Functions, which is also the one that needs
  `padEmptyBody`).
- `src/runtime/server.mts` — the Containers shell. `node:http` server on
  `PORT`/`HOSTNAME`, translating the real request into a `RuntimeRequest` and
  writing through a `NodeResponseSink`; SIGTERM/SIGINT drain via `server.close()`.
- `src/runtime/static-files.ts`, `src/runtime/image.ts`,
  `src/runtime/entrypoints.ts`, `src/runtime/load-module.ts` — the four things the
  core calls out to. `load-module.ts` is shared with the middleware runner because
  Turbopack's async modules (`module.exports` is a `Promise`, keys behind
  `Symbol(turbopack exports)`) have to be `await`ed or `handler` reads `undefined`.
- Manifest/build-output additions this step needed:
  `config.distDir` and `config.compress`; `staticFiles` became a
  `Record<pathname, repoRootRelativeKey>` (a static file's on-disk key is not
  derivable from its pathname); and `assertBuildCwd`, which pins
  `buildCwd === projectDir` so the `relativeProjectDir` Next.js inlines stays `""`
  and the runtime's `chdir` is the whole of the cwd contract.
- `.projenrc.ts` — bundles both shells (`lib/runtime/{lambda,server}.mjs`) and adds
  a `tsconfig.esm.json` + `tsc -p` step to `compile`.
- Tests: `src/runtime/http/{request,response,sink}.test.ts` (50) and
  `src/runtime/core.test.ts` (16, driving the real `handle` against a staged
  deployment tree in a tmpdir).

**Decisions**

1. **The `Dispatcher` is built per request; the `MiddlewareRunner` and
   `EntrypointRegistry` are not.** `resolveRoutes` reports
   `middlewareResponded: true` without carrying the `Response`, so the runner hands
   it back through a closure (`invokerFor(perRequest, onResponse)`) — and a closure
   shared across requests would cross-talk under the concurrency the container
   shell has. `waitUntil` is per request for the same reason. What _is_ shared is
   the expensive part: the memoized middleware module and the per-`filePath`
   entrypoint modules. (`createDispatcher` also throws for a middleware manifest
   with no invoker, so a constructor-built dispatcher was not an option anyway.)
2. **`requestMeta` carries exactly `initURL`, `hostname`, `render404`.** Read out of
   `next@16.3.5`, not guessed:
   - `initURL` — without it `RouteModule.prepare()` falls back to
     `http://localhost${req.url}` and every absolute URL a route builds is wrong.
   - `hostname` — `route-module.js` `getRouterServerContext` reads it; the port is
     included because it is concatenated into absolute URLs.
   - `render404` — `pages-handler.js` and `app-page-runtime.js` call it for a
     `notFound()` they cannot render themselves, and fall back to
     `res.end('This page could not be found')` (no status, no app 404 page) when
     it is absent.
     Deliberately **not** passed: `params`/`query` (the invocation target's `nxtP`
     query values are the documented deployed-proxy contract, and `prepare()` reads
     them), `relativeProjectDir` (`app-page-runtime.js` ignores the override and uses
     the DefinePlugin-inlined value against `process.cwd()` — hence the `chdir`), and
     `revalidate` (not consumed on any path we take).
3. **gzip lives in shared runtime code, not in a shell or in infrastructure.**
   API Gateway's `minCompressionSize` is inert under `ResponseTransferMode.STREAM`,
   and CloudFront needs a `Content-Length` a streamed response does not have. Lambda
   Web Adapter used to do this, which is why nothing in the old code mentions it.
   `res.flush()` is rewired to `compressor.flush(Z_SYNC_FLUSH)` because Next.js
   calls it after every chunk (`pipe-readable.js`); without that, streamed HTML
   sits in zlib's buffer and arrives all at once.
4. **`waitUntil` promises are awaited after the response stream closes.** Lambda
   freezes the sandbox the moment the handler resolves, so ISR revalidation
   registered with `waitUntil` would otherwise never finish. Client latency is
   unaffected; billed duration extends, which is the right trade.
5. **A broken response stream is logged, not rethrown.** Once the head is out there
   is nothing to say; rethrowing would make Lambda retry a request the client
   already abandoned.
6. **`deploymentRootOf(dirname(fileURLToPath(import.meta.url)))`**, not
   `LAMBDA_TASK_ROOT` or the image `WORKDIR`: one rule both shells and the tests
   agree on, and a consumer overriding `WORKDIR` cannot break path resolution.
7. **New `tsconfig.esm.json` type-checks `.mts`.** The repo's jsii `include` is
   `src/**/*.ts` and its eslint task is `--ext .ts,.tsx`, so both shells — the
   largest new surface in this step — were invisible to every check. `pnpm compile`
   now runs `tsc -p tsconfig.esm.json` (noEmit, `moduleResolution: bundler`) over
   `.mts` too. It found one real pre-existing error (an unused type in
   `adapter.mts`, deleted). `.mts` is still not linted; that is pre-existing.

**Measured**

| What               | Value                                    | Command                              |
| ------------------ | ---------------------------------------- | ------------------------------------ |
| tests              | 203 passed, 13 suites                    | `pnpm jest`                          |
| `core.ts` coverage | 81.6% stmts, 65.2% branch                | `pnpm jest src/runtime/core.test.ts` |
| `sink.ts` coverage | 100% stmts                               | `pnpm jest src/runtime/http`         |
| lint / types       | clean                                    | `pnpm eslint`, `pnpm compile`        |
| shell bundles      | `lambda.mjs` 1.5 MB, `server.mjs` 1.5 MB | `pnpm bundle`                        |

**Verified vs. assumed**

`core.test.ts` stages a real deployment tree in a tmpdir from the app-playground
fixture — real manifest, real `Dispatcher`, real `@next/routing`, real
`MiddlewareRunner`, real gzip — with a stub CJS module at every entrypoint
`filePath` that echoes what the runtime handed it. Verified that way: the
`requestMeta` fields above arrive; `cwd` is the staged project dir; a dynamic route
gets `/isr/42?nxtPid=42`; `x-forwarded-host` beats the `host` CloudFront rewrote;
middleware's `x-middleware-override-headers` reaches the route; a static file is
served off disk; an unknown path renders through `/_not-found` with status 404;
`requestMeta.render404()` does the same from inside a route; a trailing slash
redirects 308 with the `Refresh` fallback; HTML is gzipped for a client that
accepts it; a `waitUntil` timer completes before `handle` resolves; a throwing
entrypoint answers 500; middleware's own `Response` streams through with its
cookies split. Plus both `loadRuntime` failure messages.

Not covered by a test, and known to be unproven until the e2e suites in steps 5–7:

- **Both shells.** `lambda.mts` and `server.mts` are type-checked and bundled but
  have no tests: the event/response translation is thin, and the parts worth
  asserting (streaming semantics, API Gateway's zero-byte 502) only fail against
  real infrastructure. The e2e suites are where they get proven.
- **`proxyExternal` and the image path.** Both need a live upstream / S3.
- **Real entrypoints.** Every test entrypoint is a stub. Nothing here has yet run
  a module that `next build` produced — that is step 5's first deploy.

**Deferred / open**

- `next` stays **external** in both shell bundles, so `static-files.ts` and
  `image.ts` reach `next/dist/server/serve-static.js` and
  `next/dist/server/image-optimizer.js` at runtime. Image optimization used to be
  its own Lambda with `next` bundled _in_, so step 5 (Functions zip) and step 6
  (dropping the dedicated image function) must confirm those two modules actually
  resolve out of the traced assets the manifest stages. If they do not, the fix is
  a targeted `--external` change, not a design change.
- `RuntimeRequest.signal` is wired end to end (shell → `res.destroy()` →
  middleware `AbortSignal`), but only the container shell can produce one: Lambda
  has no client-disconnect signal.
- `padEmptyBody` is asserted at the sink level, not against API Gateway. The
  integration test that matters is step 5's `main-rgnl-fns` equivalent.

## Step 5 — wire the constructs to the staging tree

**Landed** — commit `feat: deploy the staged adapter tree from all four constructs` (referenced by subject, not SHA: this entry ships inside that commit)

All four deployment types now serve requests from the deployment root the adapter
stages, with cdk-nextjs's own shell as the entrypoint. `output: "standalone"` is
still set (it goes away in step 6), but nothing reads `.next/standalone` anymore.

- `src/nextjs-build/nextjs-build.ts` — reads and validates the adapter manifest
  (a missing one is now the error that names its own cause: `next.config` has no
  adapter registered), exposes `deploymentRootPath` + `relativeProjectDir`, and
  stages the one shell the deployment type runs into
  `<deploymentRoot>/cdk-nextjs-runtime/` alongside a copy of `manifest.json`.
  `sharp` handling moved with it: the staged tree is keyed by repo-root-relative
  path, so both the binary strip and the install search by directory name instead
  of assuming a single top-level `node_modules`, and the target is now
  glibc (`linux-<arch>`) for Functions and musl for Containers.
- `src/nextjs-compute/nextjs-functions.ts` — **`DockerImageFunction` →
  `Function` with a zip asset.** No Docker, no Lambda Web Adapter; streaming is
  `awslambda.streamifyResponse` in the shell. `overrides.dockerImageFunctionProps`
  and `overrides.assetImageCodeProps` are replaced by `overrides.functionProps`
  (breaking; step 8 documents it).
- `src/nextjs-compute/nextjs-containers.ts` + both container Dockerfiles — `COPY`
  the deployment root instead of `.next/standalone`, `CMD node
cdk-nextjs-runtime/server.mjs` instead of `node server.js`, and
  `RELATIVE_PATH_TO_PACKAGE` becomes `RELATIVE_PROJECT_DIR`.
- `src/nextjs-build/functions.Dockerfile` — deleted, along with the
  Dockerfile-copying code in `NextjsFunctions`. Functions types no longer build an
  image at all.
- `src/nextjs-api.ts` — dropped the `ResponseTransferMode.BUFFERED` workaround
  from the regional example: API Gateway does not compress a streamed response, so
  the runtime gzips it itself, and `AWS_LWA_INVOKE_MODE` has nothing left to match.

**Decisions**

1. **A generated Dockerfile is cdk-nextjs's to replace; a developer's is not.**
   `copyDockerfileToContext` used to keep any existing file. Every existing
   consumer has a generated standalone Dockerfile checked in or sitting in their
   app dir, and it runs `node server.js` — which this version no longer produces,
   so the container crash-loops on `MODULE_NOT_FOUND` with nothing pointing at the
   cause. It now overwrites a file whose first line carries the
   `# ~~ Generated by cdk-nextjs ~~` header, and the header text itself says that
   deleting it takes ownership. Found the hard way: the first `dev-rgnl-cntnrs`
   deploy failed the ECS circuit breaker with exactly that crash loop.
2. **Hoisting a store-only package picks the version with staged _code_, not the
   first version by staging key.** `hoistStoreOnlyPackages` broke on `semver`: the
   trace stages `semver@6.3.1/package.json` (read for metadata, nothing else) and
   the whole of `semver@7.8.5`, and `6.3.1` sorted first, so the hoisted
   `node_modules/semver` held one `package.json` and no modules. `sharp` then
   failed to load and **every external `/_next/image` request 200ed with the
   unoptimized original** — under next's own misleading "Module `sharp` not found.
   Please run `npm install --cpu=wasm32 sharp`". Now each candidate is scored by
   how many non-`package.json` files it stages, ties broken by path.
3. **A 404 renders as the path that was requested, not as `/_not-found`.**
   `sendNotFound` used to set `req.url = target.pathname`. The App Router
   serializes the canonical URL into the RSC payload, so that hands the client a
   payload claiming it is at `/_not-found`: wrong `usePathname()`, wrong history
   entry. The requested path is passed in instead, and `render404()` from inside a
   route leaves `req.url` alone (it is already the path that gave up). This is one
   of two places the new runtime is _more_ correct than the oracle — see Measured.
4. **The runtime consumes `x-middleware-rewrite` instead of forwarding it.**
   `@next/routing` echoes the rewrite it followed into `resolvedHeaders`; Next's
   own router treats that as an internal signal. Forwarding it leaked the app's
   post-middleware paths to clients (visible in 404 responses).
5. **Dispatch matches `/_next/image` against the middleware rewrite when there is
   one.** `resolveRoutes` routes a middleware rewrite internally but never reports
   the rewritten URL back, and `/_next/image` is not an adapter output type so it
   can never appear in `manifest.pathnames`. The API Gateway examples rewrite
   `/_next/image` → `/<stage>/_next/image` to line `basePath` up, so comparing the
   URL as received 404s every optimized image behind such a rewrite.
6. **`next`'s image-optimizer closure is traced and staged by the adapter.**
   `next build` only traces what the _app_ reaches, and no app reaches
   `next/dist/server/image-optimizer.js`, so `/_next/image` 500ed on
   `MODULE_NOT_FOUND`. `addRuntimeNextClosure` traces the four modules
   `src/runtime/image.ts` requires using next's own vendored
   `@vercel/nft` (`next/dist/compiled/@vercel/nft`) — not a new dependency, and
   not bundling, which would break the "always use the app's own `next`"
   invariant. An unresolvable `next` warns and continues (synthetic test repos); a
   missing tracer throws, because that means next moved it.
7. **The example's `/` middleware rewrite targets `/${stage}`, not `/${stage}/`.**
   There is no trailing-slash normalization after middleware in
   `resolveRoutes`: the `trailingSlash: false` 308 is compiled into
   `routes.beforeMiddleware`, and only `beforeFiles` re-runs after a rewrite. So
   `/prod/` matched nothing and 404ed. Redirecting instead would bounce off the
   stage root forever. This is an example-app bug, not a construct one, but it is
   the shape every basePath-behind-API-Gateway app hits.
8. **Generated Dockerfiles are gitignored in `examples/app-playground`.** They are
   synth output; a checked-in copy is exactly the staleness decision 1 guards
   against.

**Measured**

Packaging, recorded in the plan's "Packaging budget" table: **49 MB unzipped /
1522 files** for the one function that serves everything (34 MB `node_modules`,
14 MB `.next`, 2 MB both shells), 21 MB zipped, against the 250 MB cap. The
staged tree before dereferencing is 54 MB / 942 files.
`cp -RL <cdk.out asset> /tmp/x && du -sm /tmp/x`. **(The as-staged number is
wrong — it was measured on a `.next` that had accumulated across builds. Step 6
re-measured from a clean `.next`: 39 MB / 953. The dereferenced figure, which is
the one that counts against the cap, is unchanged.)**

Byte diff against the oracle stacks, `curl -s -o /dev/null -w
"%{http_code}/%{size_download}"`, all four deployment types (`dev-*` = this
branch, `main-*` = oracle):

| Path                                                               | dev                                     | main                |
| ------------------------------------------------------------------ | --------------------------------------- | ------------------- |
| `/`, `/isr/1`, `/ssr`, `/ssg`, `/image-optimization`, `/streaming` | identical byte counts on all four types |                     |
| `/api/health`                                                      | byte-identical                          | byte-identical      |
| `/favicon.ico` (containers, served off disk)                       | byte-identical                          | byte-identical      |
| `/_next/image` external source, `w=256&q=75`                       | 200 / **3870 B**                        | 200 / 3870 B        |
| `/_next/image?url=%2Fstatic%2F…` local source                      | 400 / 43 B                              | 400 / 43 B          |
| `/definitely-not-a-route`                                          | 404 / 24824 B                           | 404 / 24812–25031 B |

Endpoints these numbers came from — this branch: `dev-rgnl-fns`
`https://b9l6a7ml5c.execute-api.us-east-1.amazonaws.com/prod`, `dev-glbl-fns`
`https://dnc662aamspxi.cloudfront.net`, `dev-rgnl-cntnrs`
`http://dev-rg-Nextj-Q928yUh7gTNB-194292627.us-east-1.elb.amazonaws.com`,
`dev-glbl-cntnrs` `https://d26ovic7zh1qxz.cloudfront.net`. The ALB examples 403
without `Cookie: cdk-nextjs=1`.

HTML bodies differ only in the rendered timestamp and the build ID; diffed
segment-by-segment on `/isr/1` and the 404 to confirm nothing else moves.

Two places the oracle is the one that is wrong:

- **The oracle leaks a stale canonical URL across requests on a warm Lambda.** Its
  404 for `/definitely-not-a-route` came back with `"c":["","middleware"]` — the
  path of an _earlier_ request. This branch returns
  `"c":["","definitely-not-a-route"]`. The 12-byte size difference above is
  exactly that string-length difference.
- `/api/og` 500s on both, and also fails during `next build` (`TypeError: fetch
failed … Error: not implemented... yet...` at `app/api/og/route.tsx:5:23`).
  Pre-existing, not a regression.

Unit tests: `pnpm jest src/runtime` 110 passed / 7 suites;
`pnpm jest src/adapter/build-outputs.test.ts` 43 passed. `pnpm compile`,
`pnpm eslint`, `pnpm bundle` clean.

**Verified vs. assumed**

Verified against real AWS, all four types deployed from this branch and curled
next to their oracle: real `next build` entrypoints invoked in-process (the first
time anything in this rewrite has run a module `next build` produced), App Router
pages, ISR, SSR, SSG, route handlers, streaming, static files off disk
(containers), image optimization with glibc `sharp` on Lambda _and_ musl `sharp`
on Alpine, middleware rewrites including the basePath-prepending one, 404
rendering, and gzip.

Unit-tested: the hoist version-selection rule
(`build-outputs.test.ts`, a second store version staged with only its
`package.json`), the next-closure trace (fake `next` + stand-in nft), the
`/_next/image`-behind-a-rewrite and header-strip cases (`dispatch.test.ts`), and
the 404 canonical URL (`core.test.ts`).

Still assumed:

- **PPR.** Not exercised by app-playground; the plan's e2e is step 8.
- **Cold-start numbers.** Not measured. The zip function should start faster than
  the image function it replaces, but that is an expectation, not a measurement.
- **Monorepo layouts.** `relativeProjectDir` is non-empty in the fixtures and
  unit tests but every deployed example has the app at the repo root.

**Deferred / open**

- `dev-glbl-fns`, `dev-rgnl-fns`, `dev-glbl-cntnrs`, `dev-rgnl-cntnrs` are up in
  the dev account and should be torn down when the branch is done. The four
  `main-*` oracle stacks were only read (`describe-stacks`) and curled.
- Two concurrent `cdk deploy`s that both re-run `next build` in the _same_ example
  app race: CDK's `copyDirectory` walked the staged tree while the other build was
  rewriting it (`ENOENT lstat … @opentelemetry/api/…`). Deploy examples serially.
- `/middleware` 404s on both, which looks like an app-playground route that never
  existed rather than a routing gap; unconfirmed.

## Step 6 — delete `output: "standalone"` and the dedicated image function

**Landed** — commits `fix: unlink dangling sharp symlinks instead of rmSync-ing
them` and `refactor: drop output: "standalone" and the dedicated image function`
(referenced by subject, not SHA: this entry ships inside the second one)

Step 5 left the adapter still asking for `output: "standalone"` even though
nothing read `.next/standalone`. That request is now gone, and with it the last
code that only existed to serve the old layout.

- `src/adapter/adapter.mts` — `output: "standalone"` deleted from `modifyConfig`.
  The two are **alternatives, not layers**: `onBuildComplete` stages the
  deployment root from the same NFT traces `writeStandaloneDirectory` would have
  used, and `next build` says so itself immediately above the `onBuildComplete`
  call — "in the future `output: standalone` might not be allowed if an adapter
  with `onBuildComplete` is configured" (`node_modules/next/dist/build/index.js`,
  ~line 2782). `onBuildComplete` runs _before_ `writeStandaloneDirectory`, so the
  old ordering was "stage everything, then stage it a second time into a directory
  nobody opens."
- `src/nextjs-build/nextjs-build.ts` — deleted `validateNextBuildOutput()`,
  `findRelativePathToServerJs()`, the `relativePathToPackage` field, and the whole
  `prepareImageOptimizationAssets()` / `findSharpPackage()` / `copySharpRuntime()`
  path with its `imageOptimizationAssetPath`. Every one of them was keyed to
  `.next/standalone` or to the second asset the image function needed.
- **The dedicated image optimization Lambda is gone.** Deleted
  `src/image-optimization/handler.mts`, `src/nextjs-compute/nextjs-image-function.ts`,
  `src/utils/experimental-flags.ts`, and
  `src/generated-structs/OptionalDockerImageFunctionProps.ts`; removed the
  `NextjsImageFunction*` exports from `src/index.ts`, the
  `NextjsDistributionProps.imageFunctionUrl` prop with its
  `imageFunctionUrlOriginWithOACProps` override and `createImageOrigin()`, the
  `NextjsApiProps.imageFunction` prop with `imageIntegrationProps` and
  `createImageIntegration()`, and `createNextjsImageFunction()` from the base
  construct. `_next/image*` keeps its own CloudFront behavior (its cache policy
  differs — `queryStringBehavior: all()` plus `accept` in the key, right for
  images and wrong for everything else) but now points at `dynamicOrigin`; on API
  Gateway it has no resource at all and falls through to `{proxy+}`.
- `src/image-optimization/handler-utils.{ts,test.ts}` → `git mv` to
  `src/runtime/image-utils.{ts,test.ts}`; the `src/image-optimization/` directory
  no longer exists.
- `.projenrc.ts` — dropped the `src/image-optimization/handler.mts` esbuild
  bundle, its `node --check` line, and the `OptionalDockerImageFunctionProps`
  ProjenStruct. `examples/shared/suppress-nags.ts` lost its
  `CDK_NEXTJS_EXPERIMENTAL_DEDICATED_IMAGE_FUNCTION` branch; `examples/README.md`
  now tells readers to register the adapter via `adapterPath` instead of adding
  `output: 'standalone'`.

**Decisions**

1. **`rmSync(path, { recursive: true, force: true })` silently no-ops on a
   dangling symlink, so symlinks are `unlinkSync`ed and they go first.** This is a
   real bug fixed here, not cleanup: `removeExistingSharpBinaries` walked the
   staged tree removing anything matching `sharp-`, and pnpm's store directory
   names match the same substring (`@img+sharp-darwin-arm64@0.35.4`). When the
   walk reached a store directory before the links pointing into it, the links
   were left behind pointing at nothing — and `force` swallows the ENOENT that
   `rmSync`'s internal `rmdir` raises on a symlink, so the second pass reported
   success while the link stayed. Four dangling `@img/sharp-darwin-arm64` entries
   shipped in the asset. `cdk-assets` dereferences symlinks when it zips, so that
   is a latent ENOENT at package time. Confirmed with a one-liner: after
   `rmSync(p, {recursive:true, force:true})` the link is still there; after
   `unlinkSync(p)` it is not. Now the walk collects symlinks and directories
   separately and unlinks all the symlinks first. Verified: 0 dangling links in
   the deployed asset.
2. **There is no dedicated image function because middleware never ran for it.**
   The reason `/_next/image` can now live in the runtime core is architectural, not
   a size saving: dispatch classifies a request as image optimization only _after_
   middleware has had it, which is what makes `NextResponse.rewrite()` onto an
   image work at all. A separate function sitting behind its own CloudFront origin
   cannot do that. The 19 MB second asset (glibc `sharp` + handler) going away is
   a side effect.
3. **`image-utils.ts` stays split from `image.ts` for testability, and takes its
   two `next` values as parameters.** `next` is external to the shell bundles, so
   a static `import` in this file would be hoisted into a bundle where it cannot
   resolve; `image.ts` requires them through `./next-modules` and passes them in.
   That also means `image-utils.test.ts` runs without `next` present.
4. **`healthCheckPath` documents itself as Containers-only rather than becoming
   optional.** Lambda has nothing to health-check, so the Functions types accept
   it and ignore it. Making it optional is a public-API change with no
   deployment-behavior payoff, and it would still have to be required for two of
   the four types — left as a doc fix; see Deferred.
5. **`pnpm compile` must run before `pnpm projen` when a struct loses a prop.**
   `@mrgrain/jsii-struct-builder` reads the `.jsii` assembly, so the first
   `pnpm projen` regenerated `OptionalNextjsContainersProps` from a stale one and
   kept `relativePathToPackage`. Compile first, then projen.

**Measured**

After `rm -rf examples/app-playground/.next` and a fresh build:
`.next/standalone` **does not exist** — the directory `next build` used to write
unconditionally is genuinely not produced anymore. Staged deployment root 39 MB /
953 entries; dereferenced 49 MB / 1522 files (unchanged from step 5); published
zip 21,558,128 bytes. Corrected the plan's "Packaging budget" table, whose
as-staged row read 54 MB / 942 — that had been measured on an accumulated `.next`
and implied the tree _shrinks_ when dereferenced, which cannot happen.

Byte diff against the oracle, all four deployment types redeployed from this
branch (`curl -s -o /dev/null -w "%{http_code}/%{size_download}"`):

| Path                                                               | `dev-*` (this branch)                   | `main-*` (oracle)   |
| ------------------------------------------------------------------ | --------------------------------------- | ------------------- |
| `/`, `/isr/1`, `/ssr`, `/ssg`, `/image-optimization`, `/streaming` | identical byte counts on all four types |                     |
| `/api/health`, `/favicon.ico`                                      | byte-identical                          | byte-identical      |
| `/_next/image` external source                                     | identical on every type                 | identical           |
| `/definitely-not-a-route`                                          | 404 / 24824–25043 B                     | 404 / 25015–25031 B |

The only non-identical row is the 404, and it is the oracle's stale-canonical-URL
bug documented under step 5 — this branch returns the requested path, the oracle
sometimes returns a path from an earlier request on the same warm compute. The
size delta is exactly that string-length difference.

The image row is identical but not the _same_ on every type: 200 / 1869 B on
`rgnl-cntnrs`, 400 / 30 B on `rgnl-fns`, `glbl-fns` and `glbl-cntnrs`. Branch and
oracle agree on each type, which is the thing being tested; the variation is the
app's own `remotePatterns`/CloudFront caching, not the runtime.

`pnpm compile` 0 errors, `pnpm eslint` 0, `pnpm bundle` 0 (three `node --check`s
now, not four), `pnpm jest` **14 suites / 211 tests passed**.

**Verified vs. assumed**

Verified on real AWS with `output: "standalone"` absent, on all four deployment
types: `dev-glbl-fns` and `dev-rgnl-fns` (glibc `sharp` in a zip Lambda),
`dev-rgnl-cntnrs` and `dev-glbl-cntnrs` (musl `sharp` on Alpine, plus
`/favicon.ico` served off disk). Image optimization specifically was re-checked on
every type, since it is the thing that lost its dedicated function.

Still assumed: PPR (step 8's e2e), cold-start numbers (never measured — the zip
function replacing a container image function _should_ start faster, but that is
an expectation), and monorepo layouts (`relativeProjectDir` is non-empty only in
fixtures).

**Deferred / open**

- `healthCheckPath` is still required on all four root constructs while only two
  use it. Making it optional, or moving it onto the Containers props, is an API
  change for step 8's breaking-changes pass to decide.
- `docs/breaking-changes.md` still describes `.next/standalone` at lines ~45–46
  and ~177, and does not yet cover this step's removals
  (`NextjsImageFunction`, `OptionalDockerImageFunctionProps`,
  `relativePathToPackage`, `NextjsDistributionProps.imageFunctionUrl`,
  `NextjsApiProps.imageFunction`, `imageIntegrationProps`) or step 5's
  `dockerImageFunctionProps`/`assetImageCodeProps` → `functionProps`. Step 8.
- The five `dev-*`/`adptr-*` stacks I created are still up and should come down
  when the branch is done: `dev-glbl-fns`, `dev-rgnl-fns`, `dev-glbl-cntnrs`,
  `dev-rgnl-cntnrs`, `adptr-rgnl-fns`. The four `main-*` oracle stacks were only
  read and curled.

## Step 7 — splitting (`functionGroups`)

**Landed** (SHA filled in below once committed): an opt-in `functionGroups` prop
on `NextjsGlobalFunctions` and `NextjsRegionalFunctions` that packages declared
route groups into separate Lambda functions, each routed to by its own CloudFront
behaviors (Global) or API Gateway resources (Regional). Default behavior is
unchanged: no prop, one function, one deployment root, byte-identical synth.

New files:

- `src/adapter/function-groups.ts` — the grammar and resolution rules, pure and
  free of `aws-cdk-lib` so the adapter bundle can import it. Exports
  `validateFunctionGroups`, `assignRoutesToGroups`, `pathPatternsFor`,
  `parseFunctionGroupsEnv`, `assertNoI18nSplitting`, and the three constants
  (`DEFAULT_FUNCTION_GROUP`, `CDK_NEXTJS_FUNCTION_GROUPS`,
  `CDK_NEXTJS_FUNCTION_GROUP`).
- `src/adapter/function-groups.test.ts` — 36 tests.
- `src/nextjs-distribution.test.ts` — 8 synth tests, the behavior-order one being
  the assertion the plan explicitly asks for ("Assert with a synth test, not
  careful code").

Changed: `build-outputs.ts` stages one tree per group under
`.next/cdk-nextjs-adapter/groups/<name>/` and records the assignment as
`manifest.groups`; `nextjs-build.ts` resolves the staged roots, runs
`stageRuntime` + the sharp strip/install per root, and measures each;
`nextjs-functions.ts` creates one Lambda (+ Function URL) per root;
`nextjs-distribution.ts` and `nextjs-api.ts` route to them; `entrypoints.ts`
explains a misroute.

**Decisions**

1. **One source of truth, shared by two processes.** `next build` (which stages
   the trees) and synth (which wires the routing) must agree exactly, or
   CloudFront sends a request to a function whose zip lacks the entrypoint. So
   the rules live in one pure module both sides import, the resolved groups reach
   `onBuildComplete` through `CDK_NEXTJS_FUNCTION_GROUPS` (the plan's suggested
   mechanism, precedent `CDK_NEXTJS_INIT_CACHE_DIR`), and synth reads the result
   back off `manifest.groups` rather than recomputing it.
2. **`NextjsBuild` throws when the props and the manifest disagree.** Both
   directions: props asking for groups the build did not stage, and vice versa.
   The cause is always the same — a `.next` from a build that did not see this
   `functionGroups`, i.e. a stale build or `skipBuild: true` run by hand — and
   every downstream symptom is unrecognizable as that.
3. **`functionGroups` + `i18n` throws.** Not in the plan. With `i18n` every route
   template is locale-prefixed, so honoring `/pricing` would take one behavior
   per locale per pattern against a budget of 25; the alternative, a `*` in the
   locale position, captures other groups' routes. Refusing beats either.
4. **A pattern of `/` throws.** CloudFront has no path pattern matching only the
   root (the default behavior serves it), so the home page always belongs to
   `default`.
5. **A group owning a Pages Router route also gets an `_next/data/*/…` pattern**
   rather than being rejected — `NextjsBuild.hasDataRoutes` (true when any
   entrypoint is `type: "page"`) turns it on. Ownership is recorded per
   _entrypoint id_, not per template, so a page and its `_next/data` sibling — one
   file — can never be split into two zips.
6. **`NextjsFunctionGroup.overrides` is `NextjsFunctionsOverrides`, not
   `OptionalFunctionProps`** as the plan sketched. A superset: it also carries
   `functionUrlProps`, and it matches the construct-wide `overrides` key it merges
   over, so there is one shape to learn instead of two.
7. **The default group keeps the construct id `NextjsFunctions/Functions`.**
   Non-default groups are `Functions-<name>`. Adding `functionGroups` to a
   deployed app therefore does not replace the function already serving traffic.
8. **The behavior-budget error replaced the `publicDirEntries >= 22` throw** with
   one count covering all three claims (cdk-nextjs's fixed behaviors, `public/`
   entries, group patterns) and a message naming each. Incidentally corrects an
   off-by-one — the old check allowed 24 of 25 — and the basePath case, which the
   old check ignored entirely.

**Measured**

Nothing new on AWS yet; see Deferred. Unit/synth only:

```bash
pnpm compile   # jsii 0 errors, 0 warnings
pnpm eslint    # 0
pnpm jest      # 16 suites / 259 tests passed
```

**Verified vs. assumed**

Verified by test: the grammar's every rejection; longest-pattern-wins on both
sides (assignment _and_ CloudFront behavior order, independently); that a group's
staged tree contains its own routes' files and not the other group's; that the
manifest is written once and shared; that `_next/data` patterns are emitted when
Pages Router routes exist; that basePath prefixes group patterns; that the budget
error names every claim; that an unsplit build stages exactly one root and adds no
extra behaviors.

Assumed, not yet verified: **that a split app actually deploys and serves.** No
`functionGroups` deployment has been made. Also assumed: the 250 MB per-root check
fires correctly (its threshold is not reachable with `app-playground`), API
Gateway's resolution of a group's `{proxy+}` against the root `{proxy+}`, and the
`ownedRouteError` message (it needs a deliberate misroute to see).

**Deferred / open**

- The plan's exit criterion "at least one e2e exercising a split" is not met.
  Doing it next, as part of step 8, on `examples/nextjs-global-functions` with a
  group owning `/api/**` — the split to verify is that `/api/health` and `/` come
  from _different_ Lambdas and both still work.
- Everything still open from step 6 (`healthCheckPath`,
  `docs/breaking-changes.md`, the five `dev-*`/`adptr-*` stacks to tear down).

## Step 8 — tests, docs, breaking-changes

**Landed**: the e2e coverage the plan's exit criteria name, the docs rewrite, and
three product bug fixes that the new coverage exposed. Those three are separate
commits ahead of this one, because each stands alone and each is a bug present on
`main`:

- `fix: build image S3 keys from the asset key prefix, not basePath`
- `fix: forward conditional GETs to S3 through API Gateway`
- `fix: seed the init cache under the route, not the served URL`

New e2e files (`examples/e2e-tests/src/`):

- `function-groups.test.ts` — 3 tests. Proves a grouped route and an ungrouped one
  are served by _different_ Lambdas, by having the app report its own function
  name (`examples/app-playground/lib/runtime-identity.ts` plus the
  `/runtime-identity` page and `/api/runtime-identity` route). Skipped unless
  `E2E_FUNCTION_GROUPS` is set, which the `glbl-fns` CI job now sets to `api`.
- `middleware.test.ts` — the plan's "middleware e2e proving interception on
  `_next/image`". `proxy.ts` 403s exactly one image URL
  (`/static/e2e-middleware-image.png`, a committed fixture); the test asserts the 403. Without middleware in the image path the request would 200.
- `headers.test.ts` — 4 tests: ETag shape, compression when asked for, no
  compression when not, and a conditional GET returning 304. The compression pair
  is the plan's "response compression verified on both Functions types" — the LWA
  replacement, since API Gateway does not compress a streamed response.

Changed: `isr.test.ts` and `revalidation.test.ts` now settle on a timestamp
(`waitForSettledTimestamp` in `utils/wait-for-fresh-timestamp.ts`) instead of
trusting the first load after an invalidation; `examples/global-functions/app.ts`
declares `functionGroups: [{ name: "api", routes: ["/api/**"] }]` unconditionally
so CI always exercises splitting; `suppressLambdaNags` takes the group names;
`.github/workflows/e2e-tests.yml` drops
`CDK_NEXTJS_EXPERIMENTAL_DEDICATED_IMAGE_FUNCTION` from both fns jobs.

Docs: `README.md` gains a "Splitting a Large App Across Functions" section and
corrects the Docker prerequisite (Containers only) and the Dockerfile-overwrite
rule; `docs/breaking-changes.md` covers the adapter runtime, zip Lambdas,
`dockerImageFunctionProps` → `functionProps`, the removed env var and image
construct, and `functionGroups`; `docs/next-build-output-guide.md` described
standalone output and now describes the staged deployment root.

**Decisions**

1. **The three bug fixes are commits of their own, not part of this one.** They
   change `src/`, not tests, and each is independently revertable. They are
   documented above so a reader of this doc alone does not have to diff to find
   them.
2. **`functionGroups` is on in the `glbl-fns` example permanently**, not behind a
   CI-only flag. A split configuration that only exists in CI is one nobody runs
   locally; the app does not need the split, so the only cost is one extra Lambda.
3. **The middleware e2e blocks a request rather than rewriting one.** A 403 on a
   URL nothing else requests is unambiguous and cheap; a rewrite would have to
   assert on image _bytes_ to prove anything.
4. **`headers.test.ts` asserts the ETag _shape_, not a literal.** Which shape you
   get is a property of the deployment type — S3's MD5 for CDN types, `send`'s
   `<size>-<mtime>` for Regional Containers serving off local disk, and CloudFront
   weakens either when it compresses. The test discriminates file ETags from
   Next.js's rendered-page ETags, which is the actual claim.

**Measured**

Unit: `pnpm compile` 0 errors, `pnpm eslint` clean, `npx jest` 17 suites / 266
tests.

e2e against four `dev-*` stacks on this branch, `--workers=1`:

| type                                  | result               |
| ------------------------------------- | -------------------- |
| `dev-glbl-fns` (with the `api` split) | 32 passed            |
| `dev-glbl-cntnrs`                     | 29 passed, 3 skipped |
| `dev-rgnl-cntnrs`                     | 29 passed, 3 skipped |
| `dev-rgnl-fns`                        | 29 passed, 3 skipped |

The 3 skips are the `function-groups` tests, which require `E2E_FUNCTION_GROUPS`.

`rgnl-fns` reached green only after the three fixes above. It is **red on `main`**
for two of the same reasons — GitHub Actions run 35591295859 on `main` shows its
`rgnl-fns` job failing the same 5 image tests plus `ssg:5` and `streaming:11` —
so this is a pre-existing failure this branch repairs, not a regression it caused.

Cold start, `dev-rgnl-fns` vs. the `main-rgnl-fns` oracle, read-only from CW Logs:
init-only p50 **2061 ms → 342 ms (6×)**. End-to-end cold path is the honest
number and it is smaller: this branch defers server boot to the first invocation,
so ~2.5 s → ~1.4 s (**≈1.8×**). Recorded as measured, not as the 6× headline.

**Verified vs. assumed**

Verified on AWS: splitting deploys and serves (step 7's main "assumed"); a
grouped and an ungrouped route come from different function names; middleware
intercepts `_next/image`; both Functions types compress HTML; conditional GETs
304 on all four types; build-time prerenders are `x-nextjs-cache: HIT` on all
four.

Assumed still: the 250 MB per-root check's threshold (unreachable with
`app-playground`), and `ownedRouteError`'s message.

**Not done — exit criteria not met**

Stated explicitly rather than quietly dropped:

1. **PPR e2e — blocked.** Next.js 16.3 folded `experimental.ppr` into
   `cacheComponents`, which is incompatible with `dynamicParams`,
   `dynamic = "force-dynamic"` and per-route `experimental_ppr` — all of which
   `app-playground` uses, giving 12 build errors when `cacheComponents` is on.
   Getting this criterion needs a decision: migrate `app-playground` off those
   three features, add a separate minimal PPR app and stack, or defer the
   criterion. Consequence of deferring: whether manual resume code is needed
   stays unsettled. **Resolved in step 9** — migrated, and no manual resume code
   is needed.
2. **Official Next.js test harness on `NextjsRegionalFunctions` — not started.**
   The three `scripts/` executables and the filtered manifest do not exist.
3. **`healthCheckPath` API question — open.** Still required on all four root
   constructs while only the two Containers types use it.

**Deferred / open**

- `s3KeyToInvalidationPath` reverses the cache key into a CloudFront invalidation
  path without re-adding the app's `basePath`, so on a Global type _with_ a
  `basePath` the invalidation misses the path CloudFront actually cached. Same bug
  class as the fix above, different direction, and not reachable by any current
  example (the `basePath` examples are the API Gateway types, which have no CDN).
  Left for its own change rather than widened into this one.
- Six stacks of mine to tear down when the branch is done: `dev-glbl-fns`,
  `dev-rgnl-fns`, `dev-glbl-cntnrs`, `dev-rgnl-cntnrs`, `adptr-rgnl-fns`,
  `split-glbl-fns`. The four `main-*` oracles and the four `pr-267-*` stacks are
  not mine and stay.

## Step 9 — PPR: `cacheComponents` in `app-playground` + a PPR e2e

**Landed**: step 8's first unmet exit criterion. `app-playground` now sets
`cacheComponents: true` (what Next.js 16.3 folded `experimental.ppr` into) and
`examples/e2e-tests/src/ppr.test.ts` asserts the behaviour through a real
deployment. The user chose "migrate `app-playground`" over "add a separate minimal
PPR app", accepting churn across the existing suites.

**Headline finding: no manual resume chain is needed.** The plan left open whether
cdk-nextjs would have to drive PPR resumption itself. It does not, and the reason
is worth writing down because the evidence looks the other way at first.

A PPR route answers with `x-nextjs-postponed: 1`, `cache-control: private,
no-store` and no `x-nextjs-cache` header. `base-server.js` only resumes from a
request body when `this.minimalMode && req.headers['next-resume'] === '1' &&
req.method === 'POST'` — which reads like "the platform must POST the postponed
state back". That is the _minimal mode_ path, the one Vercel uses so the shell can
be served from the edge. We do not run that path. Our runtime invokes per-route
entrypoints built from `build/templates/app-page-runtime.js`, where
`isMinimalMode` comes from `getRequestMeta(req, 'minimalMode')` — request meta
that `src/runtime/core.ts` never sets. With it false, the template takes its own
branch: it appends a `TransformStream` to the response, calls `doRender({
postponed })`, and pipes the second render onto the end of the shell in the same
invocation. `next start` does exactly the same thing, and a byte-for-byte
comparison of `next start` against `dev-glbl-fns` was how this got settled.

`x-nextjs-postponed: 1` is set _before_ the resume runs (`app-page-runtime.js`,
`if (didPostpone && !isDynamicRSCRequest)`), so its presence says nothing about
whether the hole was filled. The only honest assertion is on the body.

**The migration.** Every prerender failure fell into one of the three buckets
Next.js itself names in the error, and the bucket is decided by _what_ is being
read:

- `[cache]` — a pure data function. `'use cache'` on the `fetch` in
  `app/api/categories/getCategories.ts` and `app/api/reviews/getReviews.ts`
  unblocked every non-dynamic layout at once. `notFound()` and the throw to
  `error.js` stay _outside_ the cached function: thrown out of a `'use cache'`
  scope they would be what gets stored, so one upstream blip would keep serving a
  404 for the life of the entry.
- `[stream]` — anything that reads the request. Two sub-cases:
  - Client URL hooks (`usePathname`, `useSearchParams`,
    `useSelectedLayoutSegment(s)`) _suspend_ under `cacheComponents`. Fixed with
    the upstream `vercel/next-app-router-playground` idiom: a static component
    plus a dynamic one, boundary as deep as possible, so the shell still contains
    every nav link and tab — just none of them highlighted. `ui/global-nav.tsx`,
    `ui/tab.tsx`, `ui/address-bar.tsx`.
  - `params` in a dynamic route **without** `generateStaticParams`. `'use cache'`
    does not legalize this: the shell is prerendered with no params at all, so the
    read has to be inside a boundary. For a _layout_ the directive cannot apply at
    all, because `children` is not a cacheable value. This is what the two new
    shared components exist for — `ui/category-tab-group.tsx` and
    `ui/category-content.tsx` — reused by seven `[categorySlug]` layouts and
    fourteen pages.
- `[block]` — `export const instant = false`, used only in
  `app/streaming/{edge,node}/layout.tsx`, whose whole point is reading the cart
  cookie before anything can be prerendered.

Route segment config that `cacheComponents` rejects outright
(`dynamic = 'force-dynamic'`, `dynamicParams`, `revalidate`, per-route
`experimental_ppr`) is gone. `/runtime-identity` and `/api/runtime-identity` now
`await connection()` instead of `force-dynamic` — without it Next.js prerenders
the response and every function reports the same empty identity, which would have
quietly broken the `function-groups` e2e.

**`cacheLife({ stale })` decides whether a route keeps ISR.** The one change here
with consequences beyond the example app. `/isr/[id]` first came out as
`compute: "resuming"` in `prerender-manifest.json`: served `private, no-store`,
no `x-nextjs-cache`, no `s-maxage` — the `isr` e2e had nothing left to assert and
CloudFront cached nothing. The cause was `cacheLife({ stale: 10, revalidate: 10,
expire: 60 })`. `stale` is how long a client may reuse a value without asking
again, and the prerendered shell is served with its own (`x-nextjs-stale-time:
300`); a `'use cache'` scope with a _shorter_ `stale` than the shell's cannot be
baked into the shell, so the build postpones it. Narrowed by three builds: with
`stale: 900` the route is `compute: "static"`, with `stale: 10` it is `resuming`,
`revalidate` and `expire` make no difference. The fix is `cacheLife({ revalidate:
10 })` — override only what ISR actually means and inherit the rest. `/isr/1..3`
are back to `compute: "static"`, `initialRevalidateSeconds: 10`,
`x-nextjs-cache: STALE`, `cache-control: s-maxage=10`.

Net effect app-wide: of 69 routes, exactly one _concrete_ route is not
`compute: "static"` — `/patterns/search-params`, which reads `searchParams` and
should not be. Every `[categorySlug]` dynamic route is `resuming` and the two
`/streaming/*/product/[id]` routes are `blocking`. So the CDN-caching and ISR
coverage the suite exists for is intact.

**Decisions**

1. **Migrate the app rather than add a PPR-only example.** The user's call. The
   cost is real — 39 files, and PPR semantics now apply to routes whose tests were
   written before it — but a separate minimal app would have proven PPR works in a
   stack nobody else exercises, and a fifth stack costs CI time forever.
2. **`CategoryTitle` renders one interpolated string, not `{prefix}{name}`.** Two
   adjacent JSX expressions are two text nodes and React separates them in the
   HTML with a `<!-- -->` marker, so `All <!-- -->Electronics` is what a body
   assertion actually sees. This diverges from upstream by one line and is what
   makes the ppr e2e assertable on bytes; the reason is in a comment above it,
   because it looks like something to "clean up".
3. **The ppr e2e asserts on the body, not on `x-nextjs-postponed`.** The header is
   asserted too, but only as a precondition with a comment saying why it proves
   nothing on its own. Cost of learning this the other way: several hours chasing
   a resume gap that did not exist.
4. **Deep boundaries over `instant = false`.** `instant = false` is one line and
   would have silenced every failure, at the cost of turning the whole playground
   into a set of blocking routes — i.e. deleting the thing under test. It appears
   exactly twice, in the streaming demo.

**Measured**

Build: `npx next build` exits 0. Route table shows `◐ (Partial Prerender)` for the
`[categorySlug]` routes, `/patterns/search-params`, `/isr/[id]`, `/ssr/[id]`,
`/ssg/[id]` and both `/streaming/*/product/[id]`; `/isr/1..3` and `/ssg/1..2` are
`○ (Static)` with 10s / 15m revalidate. `npx tsc --noEmit` clean, prettier clean.
No `src/` change in this step, so no `pnpm compile` / `pnpm bundle` delta.

e2e, `--workers=1`, all four stacks redeployed from this working tree:

| type                                  | result                                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| `dev-glbl-fns` (with the `api` split) | 35 passed                                                         |
| `dev-glbl-cntnrs`                     | 32 passed, 3 skipped                                              |
| `dev-rgnl-cntnrs`                     | 32 passed, 3 skipped                                              |
| `dev-rgnl-fns`                        | 32 passed, 3 skipped (first run: 31 passed, 1 failed — see below) |

The 3 skips are the `function-groups` tests, which need `E2E_FUNCTION_GROUPS`.
`dev-glbl-fns` is 35 rather than 32 because it is the stack that sets it.

`dev-rgnl-fns` failed `ssr:16` on its first run and passed the full suite twice
afterwards with no change to the deployment. It is a flake, and here is the
evidence rather than the conclusion: the failure is the browser reporting the page
slot empty — `template.tsx`'s `<Boundary>` with no children — while four
consecutive curls of `/ssr/1` returned byte-identical, complete HTML (38303 bytes,
post title present), `ssr.test.ts` passed 6/6 in isolation, and the full suite
then passed 2/2. `isr:122` failed once in the same pattern and has not recurred.
Both are the eventual-consistency class step 8 already wrote
`waitForSettledTimestamp` for, reached through a different route.

**Verified vs. assumed**

Verified on AWS: PPR resumption completes on all four deployment types — through
CloudFront, through API Gateway, and through an ALB — with the request-dependent
half present in the initial HTML, not fetched later by the client; the shell
precedes the dynamic part in the byte stream (`/patterns/search-params`, shell at
offset 11726, dynamic at 14291); a param the build never saw
(`/layouts/clothing`) resolves against the same shell; ISR survives the migration
with `x-nextjs-cache: STALE` and `s-maxage=10`.

Assumed still: that `ssr:16` is a flake rather than a PPR regression. The evidence
above is strong but it is not a root cause.

**Not done**

1. **`ssr:16` / `isr:122` on `dev-rgnl-fns` are not root-caused**, only shown to be
   non-reproducible. Recorded rather than retried away.
2. Step 8's other two exit criteria are untouched by this step: the official
   Next.js test harness on `NextjsRegionalFunctions` (not started) and the
   `healthCheckPath` API question (open).

## Step 10a — `fix: run Next.js's node-environment bootstrap before any entrypoint`

**Landed** — a real runtime bug, found by the harness work in step 10 before a
single official test had run. Recorded as its own commit because it is a product
fix, not test infrastructure.

**Symptom.** A dynamic app-page render in an app with **no middleware** kills the
Lambda: `Error: Invariant: AsyncLocalStorage accessed in runtime where it is not
available`, thrown out of `next/dist/server/app-render/async-local-storage.js`, so
the request comes back as `Runtime.ExitError` and the sandbox is destroyed.

**Cause.** That module reads `globalThis.AsyncLocalStorage` _at module scope_ and
keeps whatever it saw — if the global is not set yet, every app-render storage in
the process is Next's `FakeAsyncLocalStorage`, whose every method throws. The
global is set by `next/dist/server/node-environment-baseline.js`, and inside the
precompiled `app-page-turbo.runtime.prod.js` the load order is against us:
`work-async-storage.external.js` is required before `route-module.js` reaches the
bootstrap. Traced with a `Module._load` hook over the staged bundle:

```
[1] next/dist/compiled/next-server/app-page-turbo.runtime.prod.js   <- from the page chunk
[2]   next/dist/server/app-render/work-async-storage.external.js
[3]     ./work-async-storage-instance  -> async-local-storage.js -> throw
[5] next/dist/server/node-environment  <- from setup-node-env.external.js, too late
```

**Why no e2e caught it.** `next/dist/build/templates/middleware.js` requires the
same bootstrap, and `src/runtime/core.ts` runs middleware before it loads a page
entrypoint. `examples/app-playground` has middleware, so every one of the four
stacks was accidentally fine. The condition is narrow and entirely plausible in a
user's app: no middleware **and** a route that actually renders dynamically.

**Fix.** `setupNodeEnvironment()` in `src/runtime/next-modules.ts` requires
`next/dist/build/adapter/setup-node-env.external.js` — the bootstrap Next.js
publishes for adapters, whose own header says it "can be used to ensure Node.js
APIs are setup as expected without requiring `next-server`" — and `loadRuntime`
calls it immediately after `useNextFrom`, before anything can serve a request. It
also installs `next/dist/server/require-hook` (the `react`/`react-dom` aliasing)
and `node-polyfill-crypto`, which we were equally relying on middleware for.

Safe to call more than once: `node-environment-baseline.js` guards each global
with a `typeof` check, and CJS caching means the file body runs once per process
regardless.

**Measured**

- Reproduced off AWS by driving the staged `lambda.mjs` directly with a Function
  URL v2 event and an `awslambda` shim: throws before the fix, renders 200 HTML
  after (`node --require` of the bootstrap alone was the bisect).
- Reproduced on AWS: `/ssr` on a no-middleware fixture returned
  `Runtime.ExitError` before, `200` and a body that changes between requests
  after.
- `npx jest src/runtime src/adapter` — 243 passed, including a new
  `next-modules.test.ts` case asserting the global is a function afterwards.
  `pnpm compile`, `pnpm bundle`, `pnpm eslint` clean.

**Not done**

The four `dev-*` stacks were not redeployed for this fix, and the `examples`
e2e suite was not re-run against it. The change is additive and load-order-only,
and `examples/app-playground` has middleware, so it exercises the same end state
either way — the fixture without middleware is what proves the fix.

## Step 10 — the official Next.js compatibility harness

**Landed**: the plumbing for running vercel/next.js's own e2e suite against a real
cdk-nextjs deployment, plus an explicit three-file slice to run it on. The user
chose "plumbing + small slice" over a full port and over skipping it.

**Not landed, and this is step 8's exit criterion 2:** _the official test files
have never been run._ Running them needs a built vercel/next.js checkout
(`run-tests.js` and `test/lib/**` are repo files, not published ones), and
`pnpm install` inside that checkout was refused by this environment's permission
classifier — twice, with and without `--ignore-scripts`. So the harness is proven
against a hand-written fixture shaped like a harness temp app, on real AWS, but
"harness green for the filtered manifest" is unproven. The nightly workflow is
what will first answer it.

### What it is

| Path                                  | Role                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `scripts/e2e-deploy.sh`               | `NEXT_TEST_DEPLOY_SCRIPT_PATH`. Installs, builds through the adapter, deploys, prints the URL. |
| `scripts/e2e-logs.sh`                 | `NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH`. Markers, build/deploy log tails, CloudWatch tail.         |
| `scripts/e2e-cleanup.sh`              | `NEXT_TEST_CLEANUP_SCRIPT_PATH`. Deletes that one stack.                                       |
| `scripts/e2e-sweep.sh`                | Deletes orphaned harness stacks. Dry run unless `--apply`.                                     |
| `scripts/e2e-harness/app.js`          | The CDK app, plain CJS. `NextjsRegionalFunctions` + a Function URL.                            |
| `scripts/e2e-harness/common.sh`       | File names, stack naming, the tag check that gates every delete.                               |
| `scripts/e2e-harness/stage-static.js` | Copies `_next/static` and `public/` into the deployment package.                               |
| `test/deploy-tests-manifest.json`     | v2 filter manifest; which test files run.                                                      |
| `.github/workflows/e2e-harness.yml`   | Nightly 06:00 UTC + `workflow_dispatch`, then a sweep.                                         |

The contract was read out of next.js's source rather than taken from the docs
page, which paid for itself three times:

1. `parseIdsFromCliOutput` (`test/lib/next-modes/next-deploy.ts`) matches
   `/BUILD_ID: (.+)/` — **first match wins**. Fixtures print their own markers from
   a chained `post-build`, so ours are written to `.adapter-markers.log` and
   replayed _before_ the build log.
2. A non-zero exit from the logs script masks the deploy failure with "Custom
   deploy logs script failed". `e2e-logs.sh` traps and always exits 0.
3. `createTestDir({ skipInstall: true })` means the temp app has no
   `node_modules`, so the deploy script installs it — and `pnpm install` prunes
   directories it does not know about, which is why the adapter is copied in
   _after_.

Adapter injection needs no fixture cooperation: `NEXT_ADAPTER_PATH` is read
straight into `config.adapterPath` (`next/dist/esm/server/config-shared.js`), and
`src/adapter/adapter.mts` resolves its cache handler through
`import.meta.resolve("cdk-nextjs/cache-handler")`, so the deploy script writes a
real `node_modules/cdk-nextjs` package (this repo's `package.json` plus the two
bundled `.mjs` files) — the same trick as `examples/app-playground`'s `prebuild`.

### Headline finding: the deployment URL cannot have a path prefix

The plan assumed API Gateway's mandatory stage prefix would cost us a documentable
_class_ of excluded tests. It is worse than that: it excludes everything.
`getFullUrl` in `test/lib/next-test-utils.ts` assigns `parsedUrl.pathname =
parsedPathQuery.pathname` outright, and `base.ts` builds `new URL(url, this.url)`.
Any prefix in the deployment URL is discarded, so every absolute path a test
requests would miss `/prod` and 404.

So `app.js` deploys `NextjsRegionalFunctions` and reports a **Lambda Function
URL** (`authType: NONE`, `invokeMode: RESPONSE_STREAM`) on the same server
function: origin root, same Lambda, same adapter output, same `src/runtime`
entrypoint. The API Gateway is still in the stack and its URL is a `ApiUrl` output
for debugging by hand. Rejected alternatives: injecting a matching `basePath` (the
harness strips it anyway), CloudFront (5–15 min to create _and_ to delete, times
one per test file), an HTTP API `$default` stage (no S3 integration), a custom
domain (no domain or certificate to use).

### Second finding: a Function URL front door is incomplete without help

`_next/static` and `public/` are the two prefixes the product routes to the
`NextjsStaticAssets` bucket, and the adapter deliberately does not stage either
into the function (`src/runtime/static-files.ts` says so, and `public/` alone can
blow the 250 MB unzipped cap). A bare Function URL has no S3 integration in front
of it, so the first smoke run 404'd on every client chunk while
`manifest.staticFiles` happily listed them.

`stage-static.js` copies both directories into the staged tree between `next
build` and `cdk deploy`. It reads the adapter's build-time
`<distDir>/cdk-nextjs-adapter/manifest.json`, **not** the per-entrypoint
`cdk-nextjs-runtime/manifest.json` — those, and the runtime shells beside them,
are written by _synth_, so keying off them silently copied nothing (the bug the
second smoke run caught). It exits non-zero when it copies nothing, because the
alternative symptom is "every test fails on its chunks".

What the harness therefore does not cover: the S3 routing itself.
`examples/e2e-tests` gates that on every commit, on all four types.

### Cost model, and how the safety works

One temp app per test _file_ means one CDK deploy per test file, ~2 minutes
observed. Hence: regional functions only, nightly rather than per-commit, and an
explicit include list rather than next.js's `test/e2e/**`.

Deletes are gated twice over. Every stack carries `cdk-nextjs:harness=1` and a
`hrns-` name prefix; `harness_stack_is_ours` refuses any stack without the tag, so
neither the cleanup script nor the sweeper can touch anything else in the account
even if handed a name by hand. The sweeper additionally requires the stack to be
older than `HARNESS_SWEEP_MAX_AGE_HOURS` (default 6) so it can never delete a
running test's stack, skips `DELETE_*` states, and re-checks the tag immediately
before each delete.

Cleanup deletes through `aws cloudformation delete-stack` rather than `cdk
destroy`, which would re-synth — restaging the adapter output and reinstalling
`sharp` — for no benefit. `NextjsCache` and `NextjsStaticAssets` already use
`RemovalPolicy.DESTROY` with `autoDeleteObjects`, so a plain delete suffices.

### Decisions

1. **Report a Function URL, not the API Gateway URL.** Forced by `getFullUrl`; see
   above. The cost is S3-routing coverage, which is already covered per commit.
2. **Copy `_next/static` and `public/` into the package for harness runs only.**
   A harness-only concession, in a harness-only script, documented at both ends.
   The product's staging rules do not change.
3. **Three test files, listed explicitly.** `app-static`, `app-action`,
   `middleware-rewrites` — static/ISR, server actions, middleware. `failed` case
   lists copied verbatim from next.js's own `deploy-tests-manifest.json` at
   v16.3.5 (2, 5 and 1 cases), i.e. cases that fail on Vercel too. Widening is a
   deliberate act, not a default.
4. **`NEXT_SUPPORTS_IMMUTABLE_ASSETS: 0`.** Truthful today — static assets are
   re-uploaded under the same keys every deploy. `docs/plans/immutable-static-assets.md`
   flips it via `HARNESS_SUPPORTS_IMMUTABLE_ASSETS=1`.
5. **The CDK app is plain CJS under `scripts/`, not TypeScript under `src/`.** It
   must not enter the jsii assembly, and it runs from a temp directory outside
   `examples/` with no tsconfig to inherit. `aws-cdk` was added as a root devDep
   so the CLI exists at the repo root.
6. **Derive the stack name from the app directory rather than randomly**, so
   cleanup can recover it even if the deploy died before writing
   `.adapter-stack.txt`. Hash the full path, not the basename: fixtures with a
   `subDir` all end in `app`.

### Measured

Proven end to end against real AWS in `us-east-1`, using a hand-written fixture
shaped like a harness temp app (`package.json` with `packageManager` pinned, a
`post-build` that prints the three markers, and `/`, `/ssr` force-dynamic,
`/api/hello`):

| step                                            | result                                                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` into a `skipInstall` app         | ok                                                                                                                                                                            |
| adapter copied in, `NEXT_ADAPTER_PATH` honoured | `Applying modifyConfig from cdk-nextjs-adapter`, `Running onBuildComplete`                                                                                                    |
| markers                                         | `BUILD_ID: build-TfctsWXpff2fKS`, `DEPLOYMENT_ID: hrns-…`, `NEXT_SUPPORTS_IMMUTABLE_ASSETS: 0` — the DEPLOYMENT_ID proving our env var reaches the fixture's own `post-build` |
| `stage-static.js`                               | `.next/static` → staged tree                                                                                                                                                  |
| `cdk deploy`                                    | `✅` in 113 s, stdout carried the Function URL and nothing else                                                                                                               |
| `GET /`                                         | 200 HTML                                                                                                                                                                      |
| `GET /ssr`                                      | 200, body differs between requests — a real dynamic render                                                                                                                    |
| `GET /api/hello`                                | 200 JSON                                                                                                                                                                      |
| `GET /_next/static/chunks/*.js`                 | 200 `application/javascript`                                                                                                                                                  |
| `GET /does-not-exist`                           | 404 with the app's own 404                                                                                                                                                    |
| `e2e-logs.sh`                                   | exit 0, markers first, then build/deploy tails and the CloudWatch tail                                                                                                        |
| `e2e-cleanup.sh`                                | delete requested; stack gone                                                                                                                                                  |
| `e2e-sweep.sh`                                  | dry run listed exactly the two harness stacks and nothing else; `--apply` deleted the orphan                                                                                  |

Static checks: `bash -n` on all five shell files, `node --check` on both JS files,
`cdk synth` of `app.js` against `examples/app-playground` (one `AWS::Lambda::Url`
with `NONE`/`RESPONSE_STREAM`, stack tags present), and the manifest validated by
running next.js's real `test/get-test-filter.js` over it. `pnpm compile`,
`npx jest src/runtime src/adapter` (243 passed), `pnpm eslint` clean.

Both smoke stacks were deleted. No `main-*` or `pr-267-*` stack was touched.

### Verified vs. assumed

Verified: the whole script contract, against AWS, including that stdout carries
only the URL and that a logs-script failure cannot mask a deploy error. Verified
the two findings above by reading next.js's source and by observing the 404s.

Assumed still: that the three chosen test files pass. Nothing in this step
executed a single official test. The two things most likely to bite on the first
nightly run are the per-file deploy time against `NEXT_E2E_TEST_TIMEOUT`, and
tests that assert on response headers a Function URL sets differently from API
Gateway.

### Not done

1. **Step 8's exit criterion 2 is not met.** Stated plainly above: the official
   suite has not been run, because installing the vercel/next.js checkout was
   refused in this session. Needs approval to run `pnpm install` inside that
   checkout, or a first nightly run.
2. `healthCheckPath` (step 8's exit criterion 3) is still open, and
   `s3KeyToInvalidationPath`'s `basePath` gap is still deferred to its own change.

## Step 10b — `refactor: one shared harness stack on NextjsGlobalFunctions`

### Why this exists

Two things forced it, in this order.

**A security finding.** The harness's CDK app gave the server Lambda a Function
URL with `FunctionUrlAuthType.NONE` so that the next.js test suite — which signs
nothing — could reach it. Amazon's Palisade detector reported the function as
world accessible, Epoxy auto-mitigated it, and a ticket was filed against the
account. The user's instruction: "never do that again." The product itself was
never affected; `src/nextjs-compute/nextjs-functions.ts` only ever creates
`AWS_IAM` Function URLs, and this was harness-only code added in step 10.

**Cost.** The step-10 design deployed and deleted a stack per test file (~3-4
minutes each, plus the delete), which is most of a run's wall clock.

### What changed

`NextjsRegionalFunctions` + a public Function URL → **`NextjsGlobalFunctions`, one
long-lived stack, `cdk deploy --hotswap-fallback`.**

CloudFront is served at the origin root, which is the property the harness needs
(`getFullUrl` in `test/lib/next-test-utils.ts` assigns `pathname` outright, so a
deployment URL with a path prefix is silently truncated — which is what ruled out
API Gateway's mandatory `/<stage>` in the first place). Getting that from
CloudFront instead of from a bare Function URL means:

- No unauthenticated endpoint exists at all. The distribution fronts an `AWS_IAM`
  Function URL with OAC, exactly as a real `NextjsGlobalFunctions` deployment does.
- `_next/static` and `public/` are answered by the `NextjsStaticAssets` bucket, so
  `scripts/e2e-harness/stage-static.js` (added in step 10 to paper over a Function
  URL's lack of an S3 integration) is **deleted**, and the coverage gap it
  documented — the S3 routing itself — is closed rather than written down.
- One distribution is created per _run_ rather than per test file.

An intermediate design was written and then thrown away: keep Regional, set the
Function URL to `AWS_IAM`, and put a localhost SigV4-signing proxy
(`sigv4-proxy.js`) in front of it so nothing public existed. It worked on paper
and would have been the cheapest per-file, but CloudFront makes it unnecessary.
Deleted before commit; noted here because it is the obvious first idea.

### Files

| File                                  | Change                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/e2e-harness/app.js`          | `NextjsGlobalFunctions`; `HarnessUrl`/`DistributionId`/`ServerFunctionName` outputs; post-deploy custom-resource properties pinned; stack tag no longer carries a timestamp |
| `scripts/e2e-harness/common.sh`       | `harness_app_id` extracted; `harness_stack_name` returns the shared `hrns-shared` unless `HARNESS_ISOLATED_STACK=1`; new `harness_stack_output`                             |
| `scripts/e2e-deploy.sh`               | `--hotswap-fallback`; invalidate + wait after deploy; `NEXT_DEPLOYMENT_ID` per app dir rather than per stack; no more `stage-static.js`                                     |
| `scripts/e2e-cleanup.sh`              | keeps the shared stack; deletes only under `HARNESS_ISOLATED_STACK=1`                                                                                                       |
| `scripts/e2e-logs.sh`                 | reads outputs through `harness_stack_output`                                                                                                                                |
| `scripts/e2e-harness/stage-static.js` | **deleted**                                                                                                                                                                 |
| `.github/workflows/e2e-harness.yml`   | comments corrected; the final sweep is now the thing that deletes the stack, not a backstop                                                                                 |

### Measured

`cdk synth` of `app.js` against two different already-built example apps
(`examples/app-playground`, `examples/pages-i18n`) into the same stack name, then
a property-level diff of the two templates. Exactly five resources differ:

| Resource                                      | Changed properties                               | Hotswappable |
| --------------------------------------------- | ------------------------------------------------ | ------------ |
| `AWS::Lambda::Function`                       | `Code`, `Environment`                            | yes          |
| `Custom::CDKBucketDeployment` (static assets) | `SourceObjectKeys`, `UserMetadata`               | yes          |
| `Custom::CDKBucketDeployment` (init cache)    | `SourceObjectKeys`, `DestinationBucketKeyPrefix` | yes          |
| `AWS::S3::Bucket` (cache bucket)              | `Tags`                                           | **no**       |
| `AWS::CloudFront::Distribution`               | `DistributionConfig.CacheBehaviors`              | **no**       |

Both non-hotswappable diffs were root-caused rather than guessed:

1. **The cache bucket's tags.** `aws-cdk-lib/aws-s3-deployment` stamps
   `aws-cdk:cr-owned:<destinationKeyPrefix>:<hash>` on a `BucketDeployment`'s
   destination bucket _unconditionally_ — there is no `prune` guard on that line —
   and `src/nextjs-cache.ts:132` uses the build ID as that prefix. So any fixture
   with a `.next/cdk-nextjs-init-cache` has a non-hotswappable diff, by
   construction. A fixture without one has no init-cache deployment and does
   hotswap.
2. **The distribution's cache behaviors.** `public/` entries become behaviors
   (`addStaticBehaviors`), so a fixture whose `public/` differs from the previous
   one's changes the distribution. Observed directly: app-playground contributes
   `static/*` and `test.txt`, pages-i18n contributes neither.

**So the headline claim is narrower than "hotswap per test file", and the docs say
so.** Most test files will take the CloudFormation fallback. The saving that
survives is the one that mattered: a CloudFront distribution is created and
propagated once per run (~12 min) instead of once per test file, and a
CloudFormation update that leaves the distribution alone costs a couple of
minutes. The pinned custom resource and `--hotswap-fallback` are kept because
they are free and do take the fast path on fixtures with no init cache.

Also verified in the synthesized template: `AWS::Lambda::Url` is `AWS_IAM` (the
finding is gone), the post-deploy custom resource's properties are
`buildId: "harness"` with no `createInvalidationCommandInput`, and the three
outputs are present. `post-deploy.lambda.ts` guards on that property being
absent, which is what makes dropping it safe. `bash -n` on all five shell files,
`node --check` on `app.js`, prettier clean.

### Decisions

1. **Invalidation moved out of the custom resource and into the deploy script.** A
   hotswap never runs CloudFormation and so never runs a custom resource; and the
   CR's default `createInvalidationCommandInput` carries a
   `new Date().toISOString()` caller reference, which would itself force a
   CloudFormation deployment every time. So the script owns it: one
   `create-invalidation --paths '/*'` plus `wait invalidation-completed`, before
   the URL is reported. Blocking, because the first request the harness makes is
   the one that would otherwise read the previous fixture's response.
2. **`NEXT_DEPLOYMENT_ID` is now per app directory, not per stack.** With one
   shared stack the stack name is a constant, and two builds sharing a deployment
   ID is exactly the skew `?dpl=` exists to detect.
3. **The stack tag lost its timestamp.** A tag value that changed per deploy is a
   stack-level diff, i.e. a CloudFormation update, on every run. The sweeper ages
   stacks off CloudFormation's own `CreationTime`, which it already did.
4. **`e2e-cleanup.sh` is a deliberate no-op in shared mode**, and the workflow's
   final `always()` sweep with `HARNESS_SWEEP_MAX_AGE_HOURS: 0` is now the thing
   that deletes the stack rather than a backstop. `HARNESS_ISOLATED_STACK=1`
   restores per-file stacks and per-file deletes.
5. **`-c 1` is now load-bearing, not a tuning choice.** Two concurrent deploys
   into one stack would race.

### Verified vs. assumed

Verified: the template-level premise of the whole change (which resources differ
between two real fixtures, and which of those CDK can hotswap — read out of the
bundled CLI's `isHotswappableLambdaFunctionChange`, whose allowlist is
`["Code", "Environment", "Description"]`, plus its `Custom::CDKBucketDeployment`
support). Verified that no public endpoint remains in the harness app.

Assumed still: the per-file wall clock, which needs a real run to measure — no AWS
call was made in this step, because the session's credentials needed `mwinit`. And
still nothing has executed an official next.js test.

### Not done

1. **Step 8's exit criterion 2 remains unmet** — the official suite still has not
   been run. Unchanged from step 10.
2. **The account was not re-checked for leftovers.** The Palisade finding named
   `hrns-next-test-1790029643-...`, which belonged to a step-10 smoke stack that
   was deleted in that step, so the finding should be historical — but this was
   not confirmed, because `aws` calls failed with "You need to authenticate with
   Midway". Worth one `list-stacks --stack-status-filter ... 'hrns-*'` plus a
   Function-URL auth-type sweep after `mwinit`.
3. The two caveats a first run will need triage for, both documented in the
   harness README: the dynamic cache policy's ~10-header allowlist (a real
   CloudFront quota limitation, not a regression), and fixtures whose `public/`
   differs paying a distribution propagation.

## Step 10c — `test: warm the shared stack and run only verified test files`

The first step in which vercel/next.js's own e2e suite actually ran against a
cdk-nextjs deployment. **Step 8's exit criterion 2 is now met.**

Final result, against the committed manifest, on a warmed stack:

```
test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts finished on retry 0/2 in 265.728s
test/e2e/app-dir/segment-cache/headers-keyed-caches/headers-keyed-caches.test.ts finished on retry 0/2 in 113.259s
exiting with code 0
```

Both on attempt 0, no retries spent. Getting there turned up three things, none
of which were visible from `cdk synth`.

### 1. Every file in the previous manifest was unbuildable

The step-10 manifest listed three test files and had never been run. All three
fail at `next build`, not at a test:

| File                                     | Blocker                     |
| ---------------------------------------- | --------------------------- |
| `middleware-rewrites/test/index.test.ts` | legacy edge `middleware.js` |
| `app-dir/actions/app-action.test.ts`     | legacy edge `middleware.js` |
| `app-dir/app-static/app-static.test.ts`  | ~10 `*-edge` routes         |

`assertNodeRuntimes` (`src/adapter/build-outputs.ts`) throws on any output whose
runtime is not `nodejs`, during the build, so the whole fixture dies and a
per-case `failed` entry cannot rescue it. This is a deliberate product limitation
— the edge runtime is deprecated upstream and cdk-nextjs supports Next.js 16's
Node-runtime `proxy.ts` — so the files are excluded with the reason recorded in
the manifest's `excluded-notes`, at the user's direction ("can we ignore the
nextjs harness tests that assume edge?"). ~522 of next.js's e2e files are
edge-free, so this barely constrains widening the list.

The replacements were chosen by running them, not by reading them. That is now
written into the manifest's own comment as a rule.

### 2. The first test file of every run failed, and only passed on retry

A cold stack create is ~240s and the harness runs `createNext` inside jest's
`beforeAll`, so it is charged against `NEXT_E2E_TEST_TIMEOUT` — 240000 in CI, the
same order. Measured unwarmed: all 11 tests failed at 242s, then the retry passed
in 213s. Survivable only because `run-tests.js` retries twice, which spends a
retry the next real failure needs.

`scripts/e2e-warm.sh` now creates the stack from a throwaway app before
`run-tests.js` starts, via `e2e-deploy.sh` itself so a successful warm-up proves
the same path the test files take. Verified cold: stack deleted, warm-up created
it in 242s, then `segment-cache-basic` passed on attempt 0 where unwarmed it had
failed. Wired into the workflow before "Run the harness".

One bug found while testing it: the warm app had no `packageManager`, and
`e2e-deploy.sh` installs with `corepack pnpm`, which then resolved a pnpm it had
never downloaded and died with `MODULE_NOT_FOUND`. Both the `next` version and
`packageManager` are now read out of this repo's `package.json` so they cannot
drift from what the real fixtures use.

### 3. `deployment-skew` is a real failure, excluded pending investigation

`header with deployment id > header is set on RSC responses` fetches
`<route>?_rsc=` with an `RSC: 1` header and expects
`content-type: text/x-component`. cdk-nextjs returns
`text/html; charset=utf-8` — the HTML render, not the flight response. Failed all
three attempts, so not flaky.

Not the CloudFront header-quota caveat: `rsc` is in the dynamic cache policy
allowlist (`src/nextjs-distribution.ts`). Whether the RSC request is lost at the
edge or mishandled by the adapter's request bridge is **not established** — it
needs its own change. Recorded in `excluded-notes` as a bug to fix and bring back
as a regression test, explicitly not as an inapplicable test.

### Also in this step

- **Timings corrected to measured values.** The README, `common.sh`,
  `e2e-warm.sh` and the workflow all claimed "~12 minutes" for a distribution
  create, carried over from step 10's estimate. Measured twice at ~240s.
- **The account was re-checked** (the item step 10b left open). No `hrns-*`
  stacks, and all 8 Lambda Function URLs in the account are `AWS_IAM` with zero
  `NONE`. The Palisade finding is historical.
- **The sweeper was exercised end to end** — it deleted `hrns-shared` after
  re-checking the tag, which is how the cold warm-up test was set up.
- Committed separately as `fix:`, since it is a product fix rather than test
  infrastructure: `assertNodeRuntimes` blamed `/` for edge middleware, because
  middleware's `sourcePage` is `/`. It now reports middleware by file path and
  points at `proxy.ts`. New unit test.

### Verified vs assumed

Verified on real AWS: the full green path (temp app → install → build through the
adapter → `cdk deploy` → invalidate → tests pass); the warm-up cold, including
that it fixes the first-file failure; both manifest files passing on attempt 0;
the sweeper's tag-gated delete; the CloudFormation output fallback in
`harness_stack_output`; and the pinned post-deploy custom resource. Everything
step 10b asserted from `cdk synth` alone is now confirmed against AWS.

Assumed still: that `-c 1` is enough to keep two files from racing (never
observed failing, but never adversarially tested); and that the nightly workflow
runs green, which only a first nightly will show.

### Not done

1. **`deployment-skew`'s RSC content-type bug is not fixed**, only characterized
   and excluded. See above.
2. **The manifest is two files.** Widening it is cheap now that warm-up exists
   and the edge filter is known, but each file is still a deploy.
3. The `healthCheckPath` API question (step 8 exit criterion 3) and the
   `s3KeyToInvalidationPath` basePath gap remain open, unchanged.
