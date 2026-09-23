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

## Final — exit criteria roll-up

The plan's Status table says to record against the exit criteria in the last
entry. This is that entry, written at the point the branch opens its PR. Every
criterion from `docs/plans/adapter-runtime-release.md` "Exit criteria" is listed;
nothing is dropped silently.

| Plan exit criterion                                            | State                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| Official harness green on the filtered manifest, stacks swept  | **met, on a different `NextjsType`** (1)                            |
| All existing e2e suites green on all four types                | met (2)                                                             |
| Middleware e2e proving interception on `_next/image`           | met — `examples/e2e-tests/src/middleware.test.ts`                   |
| A PPR e2e; settles whether manual resume code is needed        | met — step 9; no manual resume code needed                          |
| Response compression verified on both Functions types          | met — `headers.test.ts`, 2 of its 4 tests                           |
| Cold-start measurement vs. the current path, lazy entrypoints  | met — step 8: init p50 2061 ms → 342 ms; end-to-end ~2.5 s → ~1.4 s |
| `functionGroups` opt-in, documented, one e2e, README size note | met — `function-groups.test.ts`; `glbl-fns` CI runs split           |
| `docs/breaking-changes.md` covering the removals               | met — step 8                                                        |
| No env var, flag, or dead code path left from development      | met (3)                                                             |

1. **Deviation, decided with the user and not a silent one.** The plan says
   `NextjsRegionalFunctions`; the harness runs on `NextjsGlobalFunctions`. Cause:
   `getFullUrl` in next.js's `test/lib/next-test-utils.ts` assigns
   `parsedUrl.pathname` outright, so the mandatory API Gateway `/<stage>` prefix
   is discarded and every absolute path the suite requests 404s. Not fixable from
   our side. Rationale in `scripts/e2e-harness/README.md` ("Why
   `NextjsGlobalFunctions`"). The criterion's substance — the official suite green
   against a real deployment, every exclusion documented, stacks verifiably gone —
   holds: two files pass on attempt 0, `run-tests.js` exits 0, exclusions are in
   `test/deploy-tests-manifest.json`'s `excluded-notes`, and `e2e-sweep.sh`
   deleted `hrns-shared` after the final run (dry run first, tag re-checked).
   Honest scope: **two** test files, not a broad slice. That was the user's
   "plumbing + small slice" choice.
2. Step 8 measured 32 passed on `glbl-fns` (with the split) and 29 passed / 3
   skipped on each of the other three, the skips being `function-groups` without
   `E2E_FUNCTION_GROUPS`. Note `rgnl-fns` is **red on `main`** for two of the same
   reasons this branch fixes.
3. Checked at close: `src/utils/experimental-flags.ts` is gone,
   `CDK_NEXTJS_EXPERIMENTAL_DEDICATED_IMAGE_FUNCTION` survives only as a
   breaking-changes note, and the only non-product `CDK_NEXTJS_*` name left is
   `CDK_NEXTJS_TEST_MARKER`, referenced exclusively from `src/runtime/core.test.ts`.

**Final unit verification** (`pnpm compile`, `pnpm eslint`, `npx jest`): 0 TS
errors, lint clean, **17 suites / 268 tests passed**.

### Open, carried past the PR

Not exit criteria — items this branch names and leaves for their own change:

1. ~~`healthCheckPath` is required on all four root constructs while only the two
   Containers types use it. An API question, not a bug.~~ **Done:** the prop moved
   off `NextjsBaseProps`/`NextjsComputeBaseProps` onto
   `NextjsGlobalContainersProps`, `NextjsRegionalContainersProps` and
   `NextjsContainersProps`, where it stays required. Breaking for the two
   Functions types, which now reject it instead of ignoring it.
2. ~~`s3KeyToInvalidationPath` does not re-add `basePath`, so a Global type with a
   `basePath` invalidates the wrong path. Not reachable from any current example.~~
   **Done:** the Global constructs pass `CDK_NEXTJS_BASE_PATH` alongside the
   distribution parameter name, and `S3CacheHandler.toCdnPath` prefixes it onto
   every invalidation path — the mapping-row ones and the `revalidatePath` tag's
   alike, since neither carries `basePath`.
3. `deployment-skew`'s RSC content-type bug: `RSC: 1` gets
   `text/html; charset=utf-8` instead of `text/x-component`. Characterized, not
   diagnosed to edge vs. adapter. Excluded with a note saying it should return as
   a regression test.
4. The harness manifest is two files; widening is cheap now.
5. Stacks of mine still up, to tear down after the PR merges: `dev-glbl-fns`,
   `dev-rgnl-fns`, `dev-glbl-cntnrs`, `dev-rgnl-cntnrs`, `adptr-rgnl-fns`,
   `split-glbl-fns`. The four `main-*` oracles and four `pr-267-*` stacks are not
   mine and stay.

## Post-PR — merge `main` (#267, derived `basePath`)

PR [#271](https://github.com/cdklabs/cdk-nextjs/pull/271) is open. It arrived
`CONFLICTING`, which had a non-obvious consequence worth recording: GitHub could
not build the `refs/pull/271/merge` ref, so **no `pull_request`-triggered workflow
ran at all** — `build` and `dependency-review` were simply absent from the checks
list, while the `pull_request_target` ones (`e2e-tests`, `pull-request-lint`,
`auto-queue`) all ran normally. A missing required check on a conflicting PR is
not a CI outage; it is the conflict.

One commit had landed on `main` since the branch point (`a01b6da`):
`de8bee3 feat!: derive basePath from the Next.js app's config for Global constructs`
(#267). Merged in, not rebased — the progress log above references step commits,
and a merge keeps those SHAs valid.

Ten conflicts. How each was settled:

| Path                                               | Resolution                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/image-optimization/handler.mts`               | stayed deleted (step 6 removed the dedicated image function)                   |
| `src/nextjs-compute/nextjs-image-function.ts`      | stayed deleted, along with `createNextjsImageFunction` in the base construct   |
| `src/nextjs-build/nextjs-build.ts`                 | both — kept the manifest imports, took `nextConfigBasePath`                    |
| `src/nextjs-static-assets.ts`                      | took `main`'s `keyPrefix: string` + `resolveKeyPrefix()`, merged the docblocks |
| `src/root-constructs/nextjs-base-construct.ts`     | `main`'s `resolvedBasePath` wiring, minus the image-function factory           |
| `src/root-constructs/nextjs-global-functions.ts`   | kept `joinPath`, dropped `useDedicatedImageFunction`                           |
| `src/root-constructs/nextjs-regional-functions.ts` | `basePath: this.resolvedBasePath`, dropped `imageFunction`                     |
| `src/runtime/image-utils.ts`                       | kept this branch's `S3AssetLocation` shape, took `main`'s better comment       |
| `src/runtime/image-utils.test.ts`                  | kept this branch's cases, ported the one `main` had that we lacked             |
| `README.md`                                        | this branch's LWA-free limitations, `main`'s fuller stage-name note            |

Notes on the judgment calls:

1. **`src/runtime/image-utils.ts` is `src/image-optimization/handler-utils.ts`
   renamed** (git tracked it as such), and the two sides had independently fixed
   the _same_ bug — this branch as `fix: build image S3 keys from the asset key
prefix, not basePath`, `main` as part of #267. Kept this branch's
   `S3AssetLocation` interface rather than `main`'s two positional string
   arguments, and deliberately did **not** adopt `main`'s `joinPath` import: the
   file's header explains that it stays free of `next` and of construct-side
   imports because it is bundled into the runtime shells. Ported `main`'s one
   extra test (a `keyPrefix` with a trailing slash) since this branch's
   normalization already handles it.
2. **`NextjsStaticAssets.keyPrefix` changed type** from `string | undefined` to
   `string`. `main`'s version is strictly better — it folds a
   `destinationKeyPrefix` override into the value the URLs are built from, so the
   two cannot drift — so this branch's duplicate assignment in the constructor was
   deleted rather than reconciled.
3. **`readNextConfigBasePath` reads `.next/required-server-files.json`**, which
   step 6 might plausibly have removed along with `output: "standalone"`. It did
   not: the file is still emitted, and this branch's runtime already loads it
   (`src/runtime/core.ts`, `src/runtime/image.ts`). Checked rather than assumed.
4. `main`'s README caveat about `responseTransferMode`/`AWS_LWA_INVOKE_MODE` was
   dropped, not merged: cdk-nextjs now supplies the Lambda handler itself and it
   streams, so the premise ("depends on whether your server Lambda supports
   response streaming") no longer holds.
5. Two stale doc references fixed in passing, both pointing at files this branch
   renamed or deleted: `examples/app-playground/middleware.ts` → `proxy.ts` in the
   README, and a `src/image-optimization/` mention in `src/runtime/http/sink.ts`.

**Measured after the merge**: `pnpm compile` 0 errors, `pnpm eslint` clean,
`npx jest` **20 suites / 312 tests passed** (up from 17/268 — `main` brought
`base-path.test.ts`, `nextjs-api.test.ts` and `nextjs-static-assets.test.ts`).

**Verified vs. assumed**: the merge is verified at the unit level only. Nothing
was redeployed after it, so #267's derived-`basePath` behavior on top of the
adapter runtime is **assumed**, resting on `main`'s own tests plus this branch's.
The PR's `e2e-tests` run on all four types is what will actually confirm it.

## Post-PR — docs congruence sweep + zero-config `NEXT_ADAPTER_PATH`

**Commit**: `docs: reconcile docs with the adapter runtime and make adapterPath optional`

**First**: the PR's `e2e-tests` run on `d6ac7fc` finished green on all four types
(`glbl-fns`, `rgnl-fns`, `glbl-cntnrs`, `rgnl-cntnrs`). That is the confirmation
the previous entry said was still outstanding: #267's derived `basePath` works on
top of the adapter runtime, verified rather than assumed.

### What this entry covers

Two things the user asked for after the PR opened: (a) a sweep of the prose docs
for claims this branch made false, and (b) whether `NEXT_ADAPTER_PATH` can remove
the `next.config` edit from the Getting Started steps. Plus a third question —
"`output: standalone` can be removed, right?" — which was already done in step 6
and is only confirmed here.

### `NEXT_ADAPTER_PATH`: adopted

Next.js sets `adapterPath: process.env.NEXT_ADAPTER_PATH || undefined` as part of
`defaultConfig` (`next/dist/server/config-shared.js`). Because it is a _default_,
an app that sets `adapterPath` explicitly still wins, so adopting this breaks
nothing. `NextjsBuild` already spawns `next build` with a controlled environment,
so `adapterPathEnv()` in `src/nextjs-build/nextjs-build.ts` is the whole change.

**The judgment call that mattered, and the one I got wrong first.** My initial
implementation resolved the adapter from cdk-nextjs's own location
(`join(__dirname, "..", "adapter", "adapter.mjs")`, matching `stageRuntime`'s
pattern), reasoning that it guarantees the adapter matches the constructs reading
its manifest. A real build proved that wrong:

```
Error [TurbopackInternalError]: FileSystemPath("app-playground")
  .join("./../../lib/adapter/cache-handler.mjs") leaves the filesystem root
- Execution of NextConfig::cache_handler failed
```

The adapter resolves its own sibling cache handler with
`import.meta.resolve("cdk-nextjs/cache-handler")` — relative to wherever _it_ was
loaded from. Loading it from outside the app's tree therefore hands Next.js a
`cacheHandler` path outside `turbopack.root`, which Turbopack refuses. So it
resolves from the app instead:
`require.resolve("cdk-nextjs/adapter", { paths: [buildDirectory] })`, which is
also exactly what the app's own `next.config` would have computed. When that
throws (legitimate: the Next.js app and the CDK app can be separate packages),
the variable is left unset and `readAdapterManifest`'s error explains it.

**Verified, not assumed.** `examples/app-playground` had its `adapterPath` removed
and was built with only `NEXT_ADAPTER_PATH` set:

```
▲ Next.js 16.3.5 (Turbopack)
  Applying modifyConfig from cdk-nextjs-adapter
✓ Running next.config.ts took 21ms
...
.next/cdk-nextjs-adapter/manifest.json   88315 bytes
```

One gap, stated in the README and in the error message rather than worked around:
with `skipBuild: true`, or any build run outside CDK, nothing sets the variable
and `adapterPath` in `next.config` is still required.

### `output: "standalone"`: already gone

Removed in step 6. Confirmed by loading `examples/app-playground`'s config through
Next.js's own loader: `output` comes back `undefined`. `docs/breaking-changes.md`
(0.5.16) and `docs/next-build-output-guide.md` already document it.

### Docs the branch had made false

| Location                                      | Was                                                                                                                                                                                       | Now                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `README.md` Getting Started                   | Step 2 required the `adapterPath` edit                                                                                                                                                    | Two steps, no config edit; a separate "Registering the adapter yourself" section covers `skipBuild` and pinning                 |
| `README.md` FAQ (containers-on-Lambda answer) | "we depend upon AWS Lambda Web Adapter to transform lambda event payloads"                                                                                                                | sentence dropped — `src/runtime/lambda.mts` does this now                                                                       |
| `docs/breaking-changes.md` 0.5.16             | "`adapterPath` in `next.config` was already required"                                                                                                                                     | records that it is now optional, and when it isn't                                                                              |
| `docs/caching-guide.md` image cache           | escape hatch via `NextjsApiProps.imageFunction` / `NextjsDistributionProps.imageFunctionUrl`                                                                                              | both props no longer exist (grep: no hits in `src/`); replaced with how `_next/image` is actually served                        |
| `docs/next-build-output-guide.md`             | `NextjsAssetsDeployment`                                                                                                                                                                  | `NextjsStaticAssets` (the construct's real name; predates this branch)                                                          |
| `examples/regional-functions/README.md` ×6    | "Lambda Web Adapter translates", stage "available in `x-amzn-request-context` header", "Middleware", "the image optimization Lambda", "fetches the source image back through API Gateway" | cdk-nextjs's own Lambda shell, the stage from `API_GATEWAY_STAGE`, "proxy", the runtime's image optimizer, and a direct S3 read |

The `x-amzn-request-context` header was the sharpest of these: it was an LWA
invention, and nothing in `src/` emits it now (grep: no hits). So
`examples/app-playground/proxy.ts` was reading a header that is never present and
silently falling through to its `API_GATEWAY_STAGE` fallback on every request —
working, but for a reason the code and docs both denied. The dead branch is
removed and the env var is now the documented mechanism, with the reason it has to
be an env var (Next.js re-enters the proxy with a synthetic request for its own
internal fetches, so there is no per-request value to read) kept.

### Checked and deliberately left alone

- `docs/init-cache-deployment.md`, `docs/pruning-guide.md`,
  `docs/development-guide.md`, `examples/README.md`,
  `examples/{app-playground,bring-your-own,e2e-tests,load-tests,pages-i18n,private-containers}/README.md`
  — swept for `server.js`, `standalone`, `image-optimization`,
  `NextjsRevalidation`, `dockerImageFunctionProps`, LWA, and removed symbol
  names. Congruent.
- A cross-check of every `Nextjs*` identifier in the prose docs against the
  package's exports turned up only the `NextjsAssetsDeployment` rename above.
  `NextjsRevalidation` in `docs/caching-guide.md` is a deliberate reference to a
  removed construct, and `NextjsApp` in `docs/pruning-guide.md` is a construct
  _id_ in an example snippet.
- `examples/e2e-tests/README.md`'s deploy-role policy still grants `sqs:*`, left
  over from the removed revalidation queue. Not narrowed: it is broader than
  needed rather than wrong, `FunctionProps.deadLetterQueueEnabled` is still a
  supported opt-in that would need it, and anyone who has already created the
  role would not pick up the change anyway.

**Measured**: `pnpm compile` 0 errors, `pnpm eslint` clean, `pnpm test` **20
suites / 312 tests passed**, one real `next build` of `app-playground` green with
`adapterPath` unset. `API.md` is unaffected (no public API change), so no
self-mutation commit is expected on this one.

## Post-PR — `NEXT_ADAPTER_PATH`, corrected after e2e failed

**Commit**: `fix: resolve the adapter from the Next.js app, keep adapterPath in the examples`

The previous entry claimed zero-config was verified and that removing
`adapterPath` from `examples/app-playground` would let e2e cover it. **The e2e run
failed on all four types**, with the same Turbopack error I had already hit once
locally:

```
TurbopackInternalError: FileSystemPath("app-playground")
  .join("./../../lib/adapter/cache-handler.mjs") leaves the filesystem root
```

### Why the local verification didn't catch it

`examples/app-playground` depends on cdk-nextjs with `link:../..`, so
`node_modules/cdk-nextjs` is a **symlink to the repo root**, and its `prebuild`
script replaces that symlink with a directory holding copies of `adapter.mjs` and
`cache-handler.mjs`. My local run had the copies left over from an earlier build,
so synth-time resolution found them. CI starts from a fresh `pnpm install`, where
the symlink is what exists at synth time — resolution followed it out of the
project, and the adapter then derived a `cacheHandler` outside `turbopack.root`.

The lesson is narrow and worth stating: **a resolution test that depends on
`node_modules` state is only valid from the state CI starts in.** The re-test
below recreates the symlink first.

### Two dead ends, and why the third form is the one

| Form                                                                          | Fails because                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `join(__dirname, "..", "adapter", "adapter.mjs")` — cdk-nextjs's own location | The adapter resolves its sibling cache handler relative to where _it_ was loaded from, so this puts `cacheHandler` outside the app's tree                                                                                                                                                                                    |
| `"cdk-nextjs/adapter"` — bare specifier, resolved by the build                | Next.js resolves `adapterPath` from inside its own config loader, i.e. from `next`'s realpath. Under pnpm that is the virtual store (`node_modules/.pnpm/next@…/node_modules/next/`), and the walk up never reaches the app's `node_modules`. Tried and measured: `MODULE_NOT_FOUND` with a `requireStack` rooted in `.pnpm` |
| `require.resolve("cdk-nextjs/adapter", { paths: [buildDirectory] })`          | **Kept.** Correct for any real install, hoisted or not, because a real install's realpath is inside the project                                                                                                                                                                                                              |

### What the examples do now, and why

`examples/app-playground` **keeps** `adapterPath`. Its `link:` dependency is
exactly the layout the env var cannot serve, and the comment in
`next.config.ts` says so. This is not a workaround for a product bug: an app
installed from npm resolves inside its own project and works with no config.

Verified that the two coexist safely — the constructs will set
`NEXT_ADAPTER_PATH=/Users/stickb/Code/cdk-nextjs/lib/adapter/adapter.mjs` here,
the escaping path, and the build is still green because the explicit
`adapterPath` wins:

```
$ rm -rf node_modules/cdk-nextjs && ln -s ../../.. node_modules/cdk-nextjs
$ rm -rf .next
$ NEXT_ADAPTER_PATH=/Users/stickb/Code/cdk-nextjs/lib/adapter/adapter.mjs npm run build
exit=0     .next/cdk-nextjs-adapter/manifest.json   88313 bytes
```

That is the property that matters for every existing user: setting the variable
cannot change the behavior of an app that already configures `adapterPath`.

The README now lists three cases where you still set `adapterPath` yourself —
`skipBuild`/external builds, cdk-nextjs being a dependency of only the CDK app,
and a `link:`/`file:` checkout outside the project root.

### Coverage gap, stated rather than hidden

**CI does not exercise `NEXT_ADAPTER_PATH`.** Every deploying example builds
`app-playground`, which must keep `adapterPath` for the reason above, so the
zero-config path is covered only by the local build recorded in the previous
entry (`adapterPath` removed, manifest written, `Applying modifyConfig from
cdk-nextjs-adapter` in the log). Closing it properly needs an example whose
cdk-nextjs comes from a real install rather than a workspace link — a packed
tarball install, most likely. Not done; carried as open.

**Measured**: `pnpm compile` 0 errors, `pnpm eslint` clean, `pnpm test` 20 suites
/ 312 tests passed, and two real `app-playground` builds from the recreated CI
starting state (symlink present): one plain, one with the escaping
`NEXT_ADAPTER_PATH` set. Both green.

## Post-PR — widening the compatibility harness manifest (screening pass, 2026-09-22)

`test/deploy-tests-manifest.json` listed two of next.js's own e2e files. It now
lists 15. This entry records how the other 22 candidates fared, because the
failures are more useful than the additions.

### What was screened

Of 1134 e2e test files in the next.js checkout, 860 are edge-free and don't
mention `isNextDeploy`. That set is mostly irrelevant to cdk-nextjs (a third of it
is `next-config-ts` variants), so 26 were hand-picked for behavior cdk-nextjs
actually implements — ISR/caching, prerender keys, route handlers, redirects and
rewrites, streaming, PPR, the segment cache — and 4 of those fell out on a second
screen: two are `describe.skip`-equivalent upstream, one fixture has edge routes,
one has a legacy `middleware.js` a directory above the test file. The remaining 22
were deployed and run for real, `-c 1 --retries 2`, against the shared
`hrns-shared` stack. Roughly two hours, ~110s per file.

The extra screens (upstream skips, `isNextDeploy`, `output: 'export'`, and the
fixture-root-is-the-parent-directory trap) are now written down in
`scripts/e2e-harness/README.md` — I hit all four the hard way.

### Added: 13 files, all observed passing

`headers-static-bailout`, `metadata-streaming`, `prefetching-not-found`,
`redirect-rewrite-dynamic`, `searchparams-static-bailout`, and eight more
`segment-cache` files (`client-params`, `encoded-slash-params`, `metadata`,
`no-prefetch`, `prefetch-auto`, `prefetch-static-shell`, `staleness`,
`vary-params`). All passed on the first attempt.

### A harness bug, found and fixed

`app.js` reported `NextjsGlobalFunctions#url` as the deployment URL. That property
appends the app's `basePath` by design (#267), and next.js's fixtures are written
against a Vercel deployment URL, which is a bare origin. Tests that interpolate
rather than `new URL()` therefore got `/base//base/refresh`. Reporting the
distribution's origin, with no trailing slash either, took
`app-dir/app-basepath` from 7 failures to 3 — and the remaining 3 are real (below).

This is worth remembering as a class of failure: a harness-shaped failure and a
product failure look identical in the log.

### Nine files not added, with reasons — three of them real bugs

Full detail is in the manifest's `excluded-notes`; in brief:

1. **Server actions, three files.** Every case that drives a server action and
   then expects the client to act on the reply fails: a `ReadableStream` action
   never streams (`actions-streaming`), an action's return value never arrives and
   React logs "An unexpected response was received from the server"
   (`dynamic-interception-route-revalidate`), and an action's `redirect()` never
   navigates (the 3 remaining `app-basepath` cases). Deterministic across all
   attempts. The function's own logs are clean — no error, ~60-80ms per invocation
   — so Next.js is answering and something about the answer is not surviving the
   trip back. cdk-nextjs's own `examples/e2e-tests/src/server-actions.test.ts`
   passes, so this is narrower than "actions are broken". **The most interesting
   open finding of the pass.**
2. **`prerender-encoding`.** A route prerendered as `sticks & stones` 404s when
   requested as `/sticks%20%26%20stones`. Reading `src/runtime/dispatch.ts`, the
   resolved pathname is looked up in `manifest.entrypoints` by plain property
   access while `lambda.mts` deliberately passes the path still percent-encoded —
   a decoded key would never match. Hypothesis, not measured.
   `segment-cache/encoded-slash-params` (`%2F`) passes, so it is narrower than
   "encoded params".
3. **`segment-cache/cached-navigations`.** 4 of 14, the same 4 every attempt:
   three prefetches issued off the inlined app shell come back with an error
   status, and one "no requests at all" assertion sees one. The equivalents that
   prefetch from a navigation rather than from the HTML all pass.
4. **`static-rsc-cache-components`.** A timing assertion measures `NaN`, i.e. the
   navigation it wanted to time never happened.
5. **Revalidation behind the CDN, two files** (`revalidate-dynamic`,
   `revalidate-path-with-rewrites`). Not a defect: the route handler does revalidate
   (`revalidated: true`), but the test refreshes about a second later and
   CloudFront serves the page it already has. Verified by hand that a prerendered
   page comes back `cache-control: s-maxage=31536000` and hits the edge on the
   second request. cdk-nextjs does invalidate on explicit revalidation
   (`invalidateCloudFrontPaths`, `src/adapter/s3-cache-handler.ts`) but
   fire-and-forget, and `CreateInvalidation` has no bounded SLA. Vercel purges its
   own CDN inline, which is why these aren't gated out of deploy mode upstream.
6. **`segment-cache/refresh`.** `describe.skip` upstream, "too flaky". Recorded so
   it isn't re-screened: it reports passing in ~5s without deploying anything.

None of 1, 2, 3 or 4 is fixed here. They are recorded in `excluded-notes` with
enough detail to be picked up cold, and each exclusion says "pending
investigation" rather than "inapplicable" so the distinction survives.

## Server actions on `NextjsGlobalFunctions` were broken, and the coverage record

Two commits: `fix: patch client fetch even when skipBuild is set`, and this one.

### The bug

Finding 1 above ("server actions, three files") turned out to be a real product
defect, not a harness artifact, and the diagnosis in that entry was wrong in the
instructive way: the function's clean logs were read as "Next.js answered and the
answer was lost on the way back". The Playwright traces (`test/traces/`, written
because `run-tests.js` sets `TRACE_PLAYWRIGHT=true`) showed the opposite — every
action POST came back **`403 InvalidSignatureException` from the edge**, having
never reached Next.js at all.

`NextjsGlobalFunctions` serves through CloudFront to a Lambda Function URL with
`AuthType: AWS_IAM`, signed by an origin access control. AWS documents that
CloudFront will sign a GET for you but will not hash a request body: the viewer
has to send `x-amz-content-sha256`, because "Lambda doesn't support unsigned
payloads". A browser cannot do that on its own.

cdk-nextjs has always had the answer — `src/nextjs-build/patch-fetch.js`, wrapping
`fetch`/`XMLHttpRequest` to compute the hash, prepended to the client entrypoint
chunks by `NextjsBuild#patchFetchInClientJs`. The bug was *where the call lived*:
inside `runNextBuild()`, so `skipBuild: true` skipped the patch along with the
build. The harness must use `skipBuild: true` (`scripts/e2e-deploy.sh` runs
`next build` itself, to emit the markers the harness parses), so every harness
deployment shipped an unpatched client — as did every user's, with that prop.

Fixed by moving the call into the constructor, outside the build gate, still
guarded on `NextjsType.GLOBAL_FUNCTIONS`. Because the same `.next` can now be
synthesized more than once (`skipBuild: true`, `synth` then `deploy`, a retried
deploy), the prepend is guarded by a `/* cdk-nextjs:patch-fetch */` marker so it
cannot double-wrap its own wrappers.

Two notes for whoever reads this next:

- `examples/e2e-tests` covers server actions and is green on
  `NextjsGlobalFunctions`, but only ever on the `skipBuild: false` path. It could
  not have caught this. The harness is the regression test, and there is no
  `NextjsBuild` unit test to add it to short of fabricating a whole `.next`.
- Read the trace before theorising from logs. A clean function log is consistent
  with the request never arriving.

### What that bought

`actions-streaming` and `dynamic-interception-route-revalidate` now pass and are
in `rules.include` (17 files). `app-basepath` goes from 13 failures to 3.

### The coverage record

`docs/harness-coverage.md` is new, and is the answer to "which files have we
tested, which failed, why, and is the failure acceptable". Every screened file has
an outcome and an explicit verdict — `pass` / `fixed` / `bug` / `unsupported` /
`CDN-inherent` / `no signal` — where "acceptable" means understood and not worth
fixing, and every `bug` row is a defect that should return as a regression test.
The manifest's `excluded-notes` stays the machine-adjacent half; the new doc is
linked from it and from `scripts/e2e-harness/README.md`.

### Still open, and a new one

The four bugs above (2, 3, 4 and `segment-cache/deployment-skew`) are unchanged.
The new fifth: `app-basepath`'s 3 remaining cases are all an action `redirect()`,
and they now fail *differently*. The POST carries the hash and reaches the origin,
but the reply arrives as `200 application/octet-stream` with none of Next.js's
headers and an HTTP/2 stream that does not close cleanly — the signature of a
`RESPONSE_STREAM` invocation whose `awslambda.HttpResponseStream.from` prelude was
never written, i.e. the head `ShimServerResponse` emits never reached
`LambdaResponseSink.begin`. The function completes in ~22ms and logs nothing.
Details, including the Next.js `createRedirectRenderResult` sub-fetch that makes
this path unlike any other action response, are in `docs/harness-coverage.md`.

## A zero-byte streamed response loses its entire head on a Function URL

Commit: `fix: pad empty streamed bodies on Lambda Function URLs too`.

### What was actually wrong

The fifth bug from the entry above — "an action `redirect()` answers with no head
at all" — is not about redirects, or actions, or `basePath`. It is this:

> A streamed Lambda response with **zero payload bytes after the metadata
> delimiter** is not recognized as a metadata response at all.

API Gateway's reaction to that was already known and already worked around: it
answers 502, and `ResponseSink.padEmptyBody` writes a single space so it does not.
A Function URL's reaction is worse, because it looks like it worked: the prelude
is silently discarded and the client gets a bare `200 application/octet-stream`
with an empty body, none of the app's headers, and an HTTP/2 stream that does not
close cleanly — whatever the real status and headers were. `padEmptyBody` was set
only for the API Gateway event shape, so Global Functions had no protection.

Measured against a live `NextjsGlobalFunctions` deployment, with padding off:

| Request                              | Answer                                              |
| ------------------------------------ | --------------------------------------------------- |
| `HEAD /base/another` (a real page)   | `200 application/octet-stream`, no `content-type`, no `etag`, no `x-nextjs-*` |
| `HEAD` on a path that 404s           | `200`                                               |
| action POST that only `redirect()`s  | `200 application/octet-stream`, no `x-action-redirect` |

and with padding on, the same three answer `200 text/html` + `etag` +
`x-nextjs-*`, `404 text/html`, and the redirect head intact. Normal GETs are
byte-identical either way. So the blast radius was every bodiless response on
Global Functions — every `HEAD`, every 204, and any response Next.js answers with
headers alone — not three test cases.

### How it was found, after three wrong guesses

Reading the code produced three plausible theories (the `"head"` event racing
`pipeToSink`'s subscription; `useDefineForClassFields` making
`typeof res.flush !== "function"`; the sub-fetch's `content-encoding` being copied
onto `res`), and all three were wrong. What settled it was **instrumenting the
deployed function**: `aws lambda get-function` → download `Code.Location` →
`console.log` probes into the bundled `lambda.mjs` at `pipeToSink` entry, the
`head` listener, `sink.begin`, the `pipeline` settle and the handler's exit →
`update-function-code` → curl → `aws logs filter-log-events`. The probe showed our
side was correct end to end:

```
[probe] pipeToSink attached POST /base/client
[probe] head {"statusCode":200,…,"x-action-redirect":"/another;push",…}
[probe] sink.begin 200
[probe] res close headersSent= true destroyed= true writableEnded= true
[probe] pipeline resolved
[probe] handle returned
```

…while the client got nothing. That is the point at which the integration, not
the runtime, is the only remaining suspect. `aws lambda
invoke-with-response-stream` is not in the installed CLI and
`@aws-sdk/client-lambda` is not a dependency here, which is why patching the
deployed code was the cheapest route to a direct observation.

### The RFC objection, and why it does not cost anything

RFC 9110 forbids a body on a 204 or a 304, and a single space technically
violates it. Losing the status and every header is the worse failure. In practice
the conflict does not arise on the CloudFront path at all: `if-none-match` is not
in the dynamic cache policy's header allowlist, so a conditional request cannot
reach the origin and CloudFront generates the 304 itself. (That also explains why
a 304 appeared to work unpadded during the investigation — it never came from
Lambda.)

`src/runtime/http/sink.ts` carries all of this on `ResponseSink.padEmptyBody`, so
nobody removes the space for looking wrong. The container sink writes to a real
`ServerResponse` and still does not set it.

## Seeded prerender headers mislabeled every RSC response as HTML

Commit: `fix: stop seeding presentational headers into APP_PAGE cache entries`.

### The bug

An RSC request to a prerendered app page (`RSC: 1`, or `?_rsc=`) returned the
correct flight payload with `content-type: text/html; charset=utf-8`, plus a
doubled `x-nextjs-prerender: 1, 1` and a doubled `vary`.

`ctx.outputs.prerenders[].fallback.initialHeaders` describes how a platform should
serve the prerendered *file* directly off a CDN. For an app page it contains
`vary`, `content-type`, `x-nextjs-stale-time`, `x-nextjs-prerender`,
`x-next-cache-tags`, and sometimes `x-nextjs-postponed` — and Next.js emits two
outputs per route, `/foo` with `text/html` and `/foo.rsc` with `text/x-component`.
`onBuildComplete` was seeding the *HTML* variant's headers wholesale into the
single `APP_PAGE` cache entry.

That is not what a cache entry's `headers` field is. At request time Next.js
stores only `metadata.headers` from the render — `x-nextjs-stale-time`,
`x-next-cache-tags`, and whatever the app set through `headers()`/`cookies()` —
never a `content-type`. `app-page-runtime.js` `appendHeader`s the cached headers
onto the response and *then* serves whichever variant was asked for, and
`send-payload.js` only sets the type when there isn't one already:

```js
if (!res.getHeader('Content-Type') && result.contentType) {
  res.setHeader('Content-Type', result.contentType)
}
```

So the seeded `text/html` won, on every RSC request to every prerendered page, on
every deployment type. The doubled `vary`/`x-nextjs-prerender` came from the same
append, since the entrypoint sets both itself.

Fixed in `appPageCacheHeaders` (`src/adapter/cache-utils.ts`, unit-tested there
rather than in the untestable `.mts`): drop `content-type`, `vary`,
`x-nextjs-prerender`, `x-nextjs-postponed`; keep the rest. `APP_ROUTE` entries are
deliberately left alone — a route handler's `content-type` *is* part of its cached
response, and `app-route.js` replays those headers verbatim.

### Why it mattered beyond one assertion

This is the same defect as three separate harness findings:

- `segment-cache/deployment-skew`'s `header is set on RSC responses` case, which
  asserts `text/x-component` directly.
- `app-basepath`'s three action-`redirect()` cases. Next.js's
  `createRedirectRenderResult` fetches the redirect target back through the
  deployment's own origin to stream it in one roundtrip, and gates that on
  `response.headers.get('content-type')?.startsWith(RSC_CONTENT_TYPE_HEADER)`. With
  `text/html` coming back it took the other branch — `response.body?.cancel()` and
  `RenderResult.EMPTY` — so the reply had no body *and* no content type. Which is
  how this bug and the `padEmptyBody` one masked each other: the empty body lost
  the head at the Function URL, and fixing that only revealed a redirect whose
  stream was never attached.
- Any client-side navigation to a prerendered route, in any app. The router
  discards a flight response that is not labeled as one.

### Verified

`app-basepath` now passes 13/13 on the first attempt (197s). Directly against the
deployment:

```
GET /base/another?_rsc=probe1   (RSC: 1)
→ 200, content-type: text/x-component, x-nextjs-prerender: 1, one vary, 3746 bytes
```

The three known e2e symptoms of it were all found by the harness and none by
`examples/e2e-tests`, which asserts on rendered pages rather than on RSC response
headers.

## The home page's cache entry had no flight payload

`fix: group the root route's .rsc and segment prerenders with its HTML`

Fourth defect the compatibility harness found, and the last of the four
`segment-cache/cached-navigations` failures. With the content-type fix above one
of them went green; the remaining three were all
`… from the initial HTML for subsequent navigations`, failing with:

```
GET /?_rsc=_aiG6yzaaivOHhuC
→ 404, content-type: application/json, x-nextjs-cache: HIT, empty body
```

`x-nextjs-cache: HIT` on a `404` is the giveaway: the entry was found, and then
something about the entry made Next.js refuse to serve it.

### The bug

Next.js emits up to three outputs per prerendered route — `/blog/hello`,
`/blog/hello.rsc`, `/blog/hello.segments/*.segment.rsc` — and `onBuildComplete`
must group them per route to seed one cache entry. `groupPrerendersByBasePath`
did that by stripping suffixes and then, in the seeding loop, looking for
`${basePath}.rsc`.

The root route cannot be named `/.rsc`, so Next emits its HTML at `/` and its
payloads at `/index.rsc` and `/index.segments/` — and with a `basePath`, at
`/prod` and `/prod/index.rsc`. The old code normalized only the exact string
`/index` → `/`, which is neither of those shapes. Measured over both fixtures:

```
no basePath      "/"            html=yes rsc=no  segments=4
basePath /prod   "/prod"        html=yes rsc=no  segments=0
                 "/prod/index"  html=no  rsc=yes segments=4  ← skipped, no HTML
```

So the home page's entry had `html` but `rscData: undefined`, and with a
`basePath` no `segmentData` either. `app-page-runtime.js` handles a missing
`rscData` by falling back to `cachedData.html.contentType`, and under
`nextConfig.cacheComponents` does `res.statusCode = 404` with
`sendRenderResult({ result: RenderResult.EMPTY })`. Hence the empty
`404 application/json` on a cache hit.

### The fix

`groupPrerenders` (`src/adapter/cache-utils.ts`) parses the emitted names instead
of reconstructing them, returning a `PrerenderVariants` per route, and remaps a
trailing `/index` onto its parent only when the parent is itself a prerendered
HTML route. The condition is load-bearing: an app with a real
`app/index/page.tsx` has a genuine `/index` route that must keep its own group,
and `/nested/index.rsc` with no `/nested` HTML is its own route rather than a
remap. Both are unit-tested, along with the two root-route shapes.

`groupPrerendersByBasePath` is deleted; the seeding loop now destructures
`variants.html` / `variants.rsc` / `variants.segments` and does no string
reconstruction at all.

### Verified

`cached-navigations` passes 14/14 on the first attempt (266s), up from 10/14
before the content-type fix and 11/14 after it.

## The coverage record now has no open bugs

`docs: record every screened harness file, its outcome and its verdict`

`docs/harness-coverage.md` and `test/deploy-tests-manifest.json` had both gone
stale — they still described `app-basepath`, `deployment-skew` and
`static-rsc-cache-components` as open bugs after the fixes that closed them, and
carried a `prerender-encoding` hypothesis that measurement disproved. Rewritten
to match what is now measured:

| File                              | Was          | Now                        |
| --------------------------------- | ------------ | -------------------------- |
| `app-basepath`                    | bug (3/13)   | pass 13/13                 |
| `segment-cache/deployment-skew`   | bug          | pass                       |
| `static-rsc-cache-components`     | bug          | pass                       |
| `segment-cache/cached-navigations`| bug (4/14)   | pass 14/14                 |
| `prerender-encoding`              | bug          | unsupported, root-caused   |

`rules.include` goes 17 → 21 files. The bug column is now empty; every one of
the five was a real cdk-nextjs defect, four of them fixed on this branch and the
fifth reclassified.

### `prerender-encoding` is not an encoding bug

Recorded because the file's name and its symptom both point the wrong way. The
fixture prerenders the param `sticks & stones` and the request for
`/sticks%20%26%20stones` 404s — but so does `/plain`, and dispatching the encoded
path against the adapter manifest resolves `nxtPid` to exactly `sticks & stones`.
Encoding is fine.

The trigger is `export const dynamicParams = false`. With it, Next.js gates the
route's `routing.dynamicRoutes` entries behind preview cookies
(`has: [{cookie __prerender_bypass, value …}, {cookie __next_preview_data}]`),
because the platform is expected to serve the concrete prerendered paths off its
CDN itself and 404 everything else. cdk-nextjs registers only dynamic
*templates* in `manifest.pathnames`, so nothing matches the gate. Proof, over the
same app with and without the flag:

```
dynamicParams = false   "/plain"                 → not-found
                        "/sticks%20%26%20stones" → not-found
flag removed            "/plain"                 → /[id]  nxtPid="plain"
                        "/sticks%20%26%20stones" → /[id]  nxtPid="sticks & stones"
```

Supporting it needs concrete prerendered paths routed to the owning entrypoint
*with* the template's `nxtP*` params — and `addPrerenderTemplates`
(`src/adapter/build-outputs.ts`) already documents that registering them naively
was measured to be actively wrong, because `/isr/1` then resolves to itself
rather than to `/isr/[id]` and loses `nxtPid`. Filed as unsupported rather than
as a bug; it is a design change, worth doing if a user asks for it.

Incidental, measured while chasing it: an unencoded `&` in a path is parsed as a
query separator (`/a&b` → `{nxtPid:"a", b:""}`), matching Vercel.

### One log-reading trap, recorded because it cost time twice

A harness file that fails *wholesale* at ~120s with
`thrown: "Exceeded timeout of 120000 ms for a hook."` in `beforeAll` has not
failed — the CloudFormation deploy outran jest's hook timeout. That is what
`--retries 1` is for. Read the retry, not attempt 0. Now noted in
`docs/harness-coverage.md` too.

## The screening funnel is measured, not asserted

`docs: record the harness screening funnel in the manifest, and measure it`

`test/deploy-tests-manifest.json` now carries a `screening` block — how many e2e
files next.js has, how many survive each of the four screens, how many are
already included — generated by `scripts/e2e-harness/screen.mjs`, with `--check`
exiting nonzero once it drifts. next.js's `test/get-test-filter.js` reads only
`version`, `suites` and `rules`, so the extra key is inert.

Measuring it corrected a number that had been repeated in three docs without ever
being counted: the claim was ~612 e2e files edge-disqualified and ~522 edge-free;
it is **203 and 931**. The edge screen must match both spellings — app router's
`export const runtime = 'edge'` and pages router's
`export const config = { runtime: 'experimental-edge' }` — and matching only the
first undercounts by ~17 files. 718 files survive all four screens, so the
edge limitation is not what constrains widening the list; deploying and watching
is.

## Batch 1 of the widening: 13 candidates, 3 more real defects

Thirteen screened candidates were run against the shared `hrns-shared` stack
(`NEXT_EXTERNAL_TESTS_FILTERS=/tmp/batch-manifest.json`, `-c 1 --retries 1`).
Seven passed outright. Of the six that did not, **three were cdk-nextjs defects**,
fixed in the three commits below; one was a pure timeout artifact; one belongs to
the already-documented CDN-inherent revalidation class; one (`asset-prefix`) is
still open.

That run also settled a misreading recorded earlier in this doc. A file failing
wholesale at ~120s is *not* evidence that "CloudFormation is slower than the
budget" — `metadata-icons` timed out at 121.9s on a **53s hotswap**. The budget
covers the whole `beforeAll`: isolating the fixture, `pnpm install`,
`next build`, the deploy, and the CloudFront invalidation wait. Measured over the
run, 7 of 9 deploys hotswapped at ~52s and only a changed
`AWS::CloudFront::Distribution / DistributionConfig` forced the ~107s fallback.
So the fix is the budget, not the deploy path: `NEXT_E2E_TEST_TIMEOUT=240000`,
now in the README's local-run recipe and already what CI uses.

### Defect 5 — a param whose name prefixes another's got the wrong value

`fix: give a route param whose name prefixes another its own value`

`test/e2e/app-dir/use-params` renders `app/[id]/[id2]/page.tsx` and, for `/a/b`,
reported `id2: "a2"`. Upstream bug in `@next/routing`: `replaceDestination`
expands a dynamic route's destination by looping the source regex's named groups
and doing one global string replace per name, in insertion order —

```js
for (const [name, value] of Object.entries(match.groups))
  dest = dest.replace(new RegExp("\\$" + name, "g"), value ?? "")
```

— so `$nxtPid`, a *prefix* of `$nxtPid2`, is substituted first and leaves the
trailing `2` as a literal. Next.js recovers `params` from exactly those query
values (`RouteModule.prepare`), so the page renders the corrupted one.

`result.routeMatches` is the raw capture map, taken before any destination
expansion, so it is the authority. `repairRouteParamQuery` in
`src/runtime/dispatch.ts` overwrites the `nxtP*` keys the expansion already
produced with their `routeMatches` values, and only those — adding others would
invent params for a rewrite that deliberately dropped them. The same collision
reaches positional `$1` inside `$10` and user `rewrites()` destinations; those
have no second source of truth and are left alone, documented in place.

Regression test: `src/runtime/dispatch.test.ts`, against the app-playground
capture with `categorySlug`/`subCategorySlug` renamed to `id`/`id2` — no
committed fixture has a natural prefix-colliding pair.

### Defect 6 — a `trailingSlash` app's canonical URLs all 404'd

`fix: resolve the canonical URL of a `trailingSlash` app`

Six of eight cases in `test/e2e/app-dir/trailingslash` failed, and all six were
one bug. `trailingSlash: true` makes `/a/` the URL Next.js's own 308 sends
browsers to, but build output pathnames never carry the slash and
`@next/routing`'s `matchesPathname` is exact string equality. So every canonical
URL resolved to nothing. Measured against a manifest built from the real fixture,
before → after:

```
/a                        redirect 308 /a/   |  redirect 308 /a/
/a/                       not-found          |  entrypoint /a           -> /a
/metadata/                not-found          |  entrypoint /metadata    -> /metadata
/api/revalidate/?lang=en  not-found          |  entrypoint /api/revalidate
/en/                      not-found          |  /[lang]/legacy          -> /en/legacy
/en/legacy/               not-found          |  /[lang]/legacy          -> /en/legacy
```

That maps 1:1 onto the failures: canonical `undefined` twice, `#a-page` never
visible twice, and `Unexpected token '<'` on both revalidate cases — the 404
*page* arriving where JSON was expected. Dynamic routes escaped it only because
their generated `sourceRegex` ends in `(?:/)?`.

Normalizing the request URL up front would loop: the add-slash redirect matches
the *slashless* path, so a pre-normalized `/a/` comes back as a 308 to `/a/`.
The fix instead teaches the match about the slash (`withTrailingSlashVariants`
adds `<pathname>/` to `pathnames`) and normalizes it off the *result*
(`Dispatcher.normalizePathname`), leaving the redirect exactly as Next.js
compiled it. Pathnames whose last segment has an extension are skipped —
Next.js compiles the *opposite* redirect for those (`/x.js/` → 308 `/x.js`) and
shadowing it would serve `/x.js/`.

Normalizing the result is load-bearing beyond the 404: `/en/legacy/` would
otherwise render under a cache key its own prerender does not use.

One thing the unit test had to work around, since it is not obvious: flipping
`config.trailingSlash` on a capture from a slashless app leaves that app's
*strip*-slash 308 in `routing.beforeMiddleware`, which fires before any pathname
is matched. The test filters it out, with a comment, because a real
`trailingSlash: true` build replaces it with the add-slash one.

### Defect 7 — the build-time cache handler was write-only, which `cacheComponents` cannot survive

`fix: read back build-time cache entries so `cacheComponents` can prerender`

`test/e2e/app-dir/resume-data-cache` did not fail tests — it failed
`next build`, so no per-case manifest entry could ever have covered it:

```
Error: Route "/": Next.js encountered uncached or runtime data during prerendering.
```

Isolated on published next 16.3.5 in a copy of the fixture, three builds:

| `next.config.js`                              | Result              |
| --------------------------------------------- | ------------------- |
| `{ cacheComponents: true }`                   | builds, 7/7 pages   |
| `+ cacheHandler` (no adapter)                 | **fails**           |
| `+ NEXT_ADAPTER_PATH`                         | **fails**           |

So the cache handler alone reproduces it and the adapter is irrelevant. The
mechanism is the two-pass prerender: pass one fills caches (every `fetch` runs
for real and is `set`), pass two must settle every await in a microtask, since
anything still pending is by definition runtime data. `CdkNextjsCacheHandler.get`
returned `null` whenever `NEXT_PHASE=phase-production-build`, so pass two found
nothing, re-issued `fetch(url, { cache: 'force-cache' })`, and Next.js aborted
the page. Next.js's own `FileSystemCache` reads back for exactly this reason.

`LocalFileCacheHandler.get` now reads the entry back — through a process-local
map first, because the two passes share a process, falling back to the JSON file
it wrote, because `next build` renders pages in worker processes that do not.
A dead end ruled out on the way: `hasCustomCacheHandler` in
`packages/next/src/server/lib/incremental-cache/index.ts` is only consulted for a
2MB size limit, so it is not the mechanism.

Both configurations now build. Regression test:
`src/adapter/cache-handler.test.ts` — set, then get from the same instance *and*
from a second one, proving the file path and not just the map.

## Batch 1, resolved: every verdict written down

`docs: record batch 1's verdicts, and fix tag revalidation for prerenders`

The rerun with `NEXT_E2E_TEST_TIMEOUT=240000` settled what batch 1 actually
found. Eight of the thirteen candidates pass and are now in `rules.include`:
`app-client-cache/client-cache.defaults`, `interception-dynamic-segment`,
`metadata-icons`, `not-found-default`, `segment-cache/prefetch-app-shell`,
`server-actions-relative-redirect`, `use-cache-private`,
`use-cache-search-params`. `use-params` joins them now that defect 5 is fixed —
it passed on the first attempt, 166s.

`metadata-icons` is worth naming: it was recorded as a batch-1 failure and was
not one. It timed out at 121.9s against a 120s `NEXT_E2E_TEST_TIMEOUT` while the
deploy it was waiting on took 53s, so the budget was the whole problem. Nothing
about the deploy path needed changing.

That leaves one open bug and one more defect.

### `asset-prefix` is a real gap, and it is not about routing

**Verdict: bug**, 2 of 7 cases, reproducible across two attempts (127.9s,
107.2s). Left out of `rules.include` with the reason recorded in the manifest's
`excluded-notes` and the measurement in `docs/harness-coverage.md`.

The stack traces all point at the fixture's rewrite cases, and that is a red
herring: the bundle assertions live in an un-awaited
`bundles.forEach(async (src) => { … })`, so jest attributes the rejection to
whichever test happened to be running. Every trace resolves to the `forEach`
line.

Routing is fine, measured directly. Running the full runtime locally against a
hand-assembled deployment root — no AWS at all, `PORT=3999 node
cdk-nextjs-runtime/server.mjs` — returns `200 {"message":"test"}` for
`/api/test-json`, `/not-custom-asset-prefix/api/test-json` and
`/custom-asset-prefix/api/test-json`.

What fails is the prefixed bundle URL. From the built manifest: `assetPrefix` is
`/custom-asset-prefix`, the 13 `staticFiles` keys are all unprefixed
(`/_next/static/…`), and the staged Lambda tree has no `.next/static` directory —
the assets live in S3 behind CloudFront's `_next/static*` behavior. So
`/custom-asset-prefix/_next/static/…` misses that behavior, falls through to the
compute's default behavior, gets rewritten to `/_next/static/…`, and 404s on a
file that was never packaged. Two candidate fixes, neither a one-liner: an extra
behavior for `${assetPrefix}/_next/static*` on the static origin plus a
prefix-stripping function, or deploying the static assets under the prefixed key
as well. `assetPrefix` is also undocumented in `README.md` and `docs/`.

### Defect 8 — `revalidateTag` could not reach a single build-time prerender

`fix: make tag revalidation reach build-time prerenders`

Three files were failing on the same thing, which is what made it findable:

| File                                    | Failing case                                              |
| --------------------------------------- | --------------------------------------------------------- |
| `app-dir/trailingslash`                 | `should revalidate a page with generated static params` ×2 |
| `app-dir/segment-cache/prefetch-inlining` | `preserves prefetch hints after on-demand revalidation`  |
| `app-dir/resume-data-cache`             | the static/dynamic consistency pair, flakily — retry 0 failed the `fetch cache` variant, retry 1 the `use cache` one |

`trailingslash` is the clearest reading: the page renders, the revalidation
returns, and `generated-at` never changes.

```
expect(received).not.toBe(expected)
Expected: not "2026-09-22T19:26:01.255Z"
```

Two bugs, both in `src/adapter/s3-cache-handler.ts`.

**Seeded prerenders had no tags to check.** A build-time prerender is written as
a JSON file by the adapter's `onBuildComplete`, never through `set`, so it has no
`tags` array and no DynamoDB mapping rows. `get` read tags only from that array,
found none, and skipped the revalidation check entirely — so no statically
prerendered page was reachable by `revalidateTag`/`revalidatePath` until some
later runtime re-render happened to replace the entry. An app whose pages are all
static never revalidated at all. Verified against a real seeded entry, which
carries them in the render's header instead, exactly where Next.js's own
`IncrementalCache.get` looks:

```
"x-next-cache-tags": "_N_T_/layout,_N_T_/page,_N_T_/,_N_T_/index,test"
```

**The revalidation was recorded in the wrong place.** `revalidateSingleTag`
stamped `revalidatedAt` onto the tag's existing mapping rows, which are per cache
*key* — so a tag with no rows recorded nothing at all, and
`checkIfRevalidated` then read whichever row a `begins_with` + `Limit: 1` query
happened to return, judging one entry against another's timestamp. It now writes
a marker row keyed by the bare tag (mapping rows are `tag#cacheKey`, so no
collision) and reads that row by primary key, in parallel across the entry's tags
because a prerender carries its whole implicit `_N_T_/…` chain.

One more thing fell out of reading it: `storeDynamoDBTagMappings` set
`revalidatedAt = now` when *creating* a mapping row. That timestamp is taken
after the entry's own `lastModified`, so every tagged entry looked revalidated the
moment it was stored — `checkIfRevalidated` deleted healthy entries and the page
re-rendered on every request. Mapping rows now record only `createdAt`.

Ruled out along the way, so it is not re-investigated: `postponed` (which carries
the resume data cache, serialized as `<len>:<postponed><renderResumeDataCache>`)
*is* seeded, `segmentData` round-trips with the right keys (`/_tree`, `/_full`,
`/__PAGE__`), and a missing `cacheControl` on a seeded entry is harmless —
Next.js takes cache control from the prerender manifest, not from the entry.

Regression test: `src/adapter/s3-cache-handler.test.ts` walks a seeded entry
through all three marker states (absent, older, newer) and asserts the marker
row's shape.

### Defect 9 — on-demand revalidation left the CDN copy of a prerender untouched

Defect 8 fixed the origin: after a `revalidatePath` the Lambda re-renders. The
browser still saw the old page. A prerendered app-router response is served
`cache-control: s-maxage=31536000`, so CloudFront answered from the edge, and
`revalidateTag` derived its invalidation paths only from the tag's DynamoDB
mapping rows — which a build-time prerender does not have, for exactly the reason
defect 8 turned on. Measured before fixing:

```
$ curl -sI 'https://…/?_rsc=probe' -H 'RSC: 1' -H 'Next-Router-Prefetch: 1' \
    -H 'Next-Router-Segment-Prefetch: /__PAGE__'
cache-control: s-maxage=31536000
x-cache: Miss from cloudfront      # `Hit from cloudfront` on the second call
```

Three parts, in `src/adapter/s3-cache-handler.ts` and
`src/lambdas/post-deploy/`:

- **The tag names the path.** `revalidatePath("/blog")` reaches the handler as
  tag `_N_T_/blog` (`NEXT_CACHE_IMPLICIT_TAG_ID`), so `implicitTagPath` recovers
  a CDN path with no mapping row at all. A dynamic template (`_N_T_/blog/[slug]`)
  is skipped — it matches no cached URI. `revalidateSingleTag`'s tail was
  restructured so the CloudFront step still runs when the query returns zero
  rows; previously it was inside `if (queryResponse.Items)`.
- **Four URI forms per path** (`invalidationVariants`). An invalidation path
  matches only the query string it spells out, and a page's RSC payload is cached
  under `?_rsc=<hash>`; dropping the HTML while leaving the payload behind leaves
  the router navigating to the pre-revalidation page. Both slash variants too,
  because a `trailingSlash` app's cached URI is the redirect target. `?*` is
  accepted by `CreateInvalidation` — validated live, not assumed.
- **Mapping rows for build-time prerenders.** The adapter writes
  `_cdk-nextjs-tag-manifest.json` (tag → cache keys, from each entry's
  `x-next-cache-tags`) into the init cache, and the post-deploy custom resource
  turns it into the rows a runtime `set` would have written, which is what
  `revalidateTag("posts")` on a static page needs. That resource now also depends
  on the init-cache upload: CloudFormation orders nothing between the two custom
  resources, and invalidating before the new cache is uploaded would only re-cache
  what the invalidation was meant to drop. Constants shared via
  `src/adapter/cache-utils.ts` so three call sites cannot drift.

Measured after: `segment-cache/prefetch-inlining` went 14/15 → **15/15 on retry
0**, so it joins `rules.include`. `trailingslash` stayed 6/8, identically on both
attempts — and that turned out to be a stopwatch, not a defect. `retry()` in
next.js's `test/lib/next-test-utils.ts` defaults to `duration = 3000`;
`prefetch-inlining` passes `15000`. An invalidation lands inside 15s and not
inside 3s. Same verdict as the already-recorded `revalidate-dynamic` pair.

Only the first two parts are under harness coverage: the harness updates Lambda
code by hotswap, which never runs CloudFormation, so the post-deploy resource does
not fire between fixtures. `seedTagMappings` has a unit test instead
(`src/lambdas/post-deploy/seed-tag-mappings.test.ts`, 3 cases — row shape,
missing-manifest no-op, and 26 rows batching into 3 `BatchWriteItem` calls with
`UnprocessedItems` retried).

One trap worth recording: that test wrote nothing at first. The module builds its
`S3Client`/`DynamoDBClient` at import time, which happens on the hoisted
`import`, before any `mockImplementation` statement in the test body runs — so it
captured automock instances whose `send` returned `undefined`. Mock
`Client.prototype.send`, not the constructor.

### Partly-failing files now contribute their passing cases

Three of the user's asks converge here: document which cases have been tried and
why each failure is acceptable, keep widening, and keep the overview machine-
readable. next.js already has the mechanism — a file listed in the manifest's
`suites` is *included*, with the cases in its `failed` array skipped
(`test/get-test-filter.js` → `excludedCases` → a negative `--testNamePattern` in
`run-tests.js`). The project had never used it; `suites` was `{}`.

Two files moved in, each verified by its own deploy run rather than assumed:

| File                        | Cases | Skipped                                        | Result           |
| --------------------------- | ----- | ---------------------------------------------- | ---------------- |
| `app-dir/trailingslash`     | 6 / 8 | the 2 `revalidate a page with generated static params` | green, retry 0, 123s |
| `app-dir/resume-data-cache` | 3 / 5 | the 2 `consistent data between static and dynamic renders` | green, retry 0, 139s |

Names have to be full jest names, `describe` title included, and for `it.each`
the interpolated title spelled out per case.

`resume-data-cache` gets a new verdict class, **architectural**: the skipped cases
assert that the first dynamic RSC request after a tag revalidation still returns
*stale* data. Next.js keeps tag staleness in `tagsManifest`, a plain in-process
`Map` in `tags-manifest.external.ts`, and `areTagsStale` reads only that Map. A
distributed cache handler has no channel for "stale, serve it anyway" — `null` is
a miss and `lastModified: -1` is also a blocking render — so ours is immediately
fresh. The failing assertion is that cdk-nextjs is *too* fresh. The second of the
two would additionally fail from CloudFront serving the first case's payload under
an identical `_rsc` hash.

Also in this commit: `screen.mjs` now counts `suites` files as included rather
than as candidates (a new `included-in-part` figure; candidates 718 → 706), and
both the manifest's top-level comment and
`scripts/e2e-harness/README.md` record the convention — a cdk-nextjs bug is never
a `failed` entry, but once a failure has an acceptable verdict in
`docs/harness-coverage.md`, `suites` is how the rest of the file keeps earning.

Coverage record: 39 files deployed, 31 whole files in `rules.include`, 2 more in
part, 9 fixed defects, 1 open bug (`assetPrefix`).

### Batch 2: a third of the candidate pool was never going to run

Fourteen candidates picked for breadth (pages-router routing, client cache,
fetch deduping, root params, binary RSC). Eleven of them finished in about four
seconds each, having deployed nothing.

The cause is a screen that did not exist: `nextTestSetup({ skipDeployment: true })`
makes next.js replace the whole file with `it.only('should skip next deploy')` and
set `skipped`, so the body early-returns (`test/lib/e2e-utils/index.ts`). jest
reports a pass. It is the same false-coverage trap as `describe.skip`, and it is
far more common — **236 of the 706 files then counted as candidates**. Screening
for it took the pool to 465, and added a `scaffold` screen on the way
(`test-template/{{ toFileName name }}` is a `pnpm new-test` template, not a test).

Worse, it had already cost two rows: `app-dir/not-found-default` and
`app-dir/use-cache-search-params` were in `rules.include` on the strength of such
a pass and had never run. Both removed. That is the second time the coverage
record has had to be corrected downward for claiming a file it had not measured,
so the rule is now written in both the README and `docs/harness-coverage.md` as a
measured backstop rather than a pattern list: **a file that passes in under ~10
seconds deployed nothing.** `--timings` prints the duration, which for a passing
file is the only signal in the log — `run-tests.js` prints output on failure only.

`app-fetch-deduping` is why the backstop is needed and not just the screen: it has
no `skipDeployment`, it branches on `isNextStart`/`isNextDev`, and deploy mode gets
`it('should skip other scenarios', () => {})`.

Of the three files that did deploy: `app-dir/catchall-specificity` (2 cases) and
`app-dir/app-root-params-getters/generate-static-params` (4) passed and are in
`rules.include`.

### Defect-free finding: CloudFront rejects unencoded `[` and `]`

`dynamic-route-interpolation` failed 4 of 7, identically on both attempts. Every
failure requests a path whose square brackets are literal rather than a dynamic
segment — `/blog/[slug]`, `/api/dynamic/[abc]` — and every one received an empty
body. Probed directly against the deployment:

```
$ curl -sg --path-as-is -D - -o /dev/null 'https://…/blog/[slug]'
HTTP/2 400
content-length: 0
x-cache: Error from cloudfront
```

`x-cache: Error from cloudfront` with no body: CloudFront answers before the
Lambda is reached. Percent-encoded, the same routes are correct —
`/blog/%5Bslug%5D` renders `[slug]` into `#slug` and `/api/dynamic/%5Bslug%5D`
returns `slug: [slug]` — so routing and param interpolation are fine and it is
the wire format CloudFront refuses. `[` and `]` are `gen-delims`, reserved for
IPv6 literals in the authority and not legal in a path, so CloudFront is within
spec. Verdict CDN-inherent; the file is in `suites` with those 4 excluded, which
banks its other 3 (verified green, retry 0, 123s).

Coverage record: 51 files screened, 31 whole files in `rules.include`, 3 more in
part, 9 fixed defects, 1 open bug (`assetPrefix`), 465 candidates left.

### Batches 3 and 4: twelve more files banked, three defects, two harness gaps

Twenty-five file-runs across two batches, widening into error boundaries, client
navigation, metadata, and PPR/fallback-shell behavior. Twelve files went green and
are in `rules.include`: `catch-error`, `error-boundary-navigation`,
`global-error/basic`, `interception-dynamic-single-segment`, `metadata-navigation`,
`not-found-with-pages-i18n`, `optimistic-routing`, `pages-router-app-not-found`,
`router-autoscroll`, `shallow-routing`, `static-siblings`,
`use-selected-layout-segment-s`. That takes the record to 43 whole files plus 3 in
part, out of 72 screened.

`router-autoscroll` is the one that needed retry 1 — the fixture's own scroll
assertions, no cdk-nextjs error on either attempt. Listed, because the harness runs
with `--retries 1`, but flagged in `docs/harness-coverage.md` as the file to
suspect first if a nightly goes red for no other reason.

**Defect 10, the one that mattered: every fixture shared one cache namespace.**
`error-boundary-navigation` (5 of 7) and `metadata-navigation` (1 of 7) were
serving *another fixture's* `/_not-found` page. `next/dist/build/index.js`'s
`getBuildId()` returns the literal constant `build-TfctsWXpff2fKS` whenever
`config.deploymentId` is set — deliberately, so tools can `.replace()` it — and
`scripts/e2e-deploy.sh` sets `NEXT_DEPLOYMENT_ID` per fixture. cdk-nextjs keys its
entire cache partition off `buildId` (S3 prefix, DynamoDB pk, static-asset
metadata, post-deploy pruning and seeding), so every app that turned on skew
protection shared one namespace. Fixed by suffixing the deployment id; verified by
one S3 prefix per fixture and both files going 7 of 7.

Two more defects, both found and fixed the same way but verified against a re-run
that was still in flight at this commit: **11**, an unmatched optional catchall
arriving as `nxtPparams: ""` and making a layout render a segment nobody requested
(`layout-params`, 1 of 6 — fixed in `repairRouteParamQuery`, unit-tested); and
**12**, static metadata routes going out as `application/octet-stream` because they
are staged as `<route>.body` and `send` types from the file's extension
(`use-cache-metadata-route-handler`, 3 of 10 — fixed in `setBodyFileContentType`).
Both are written up in full in `docs/harness-coverage.md`.

**Two harness gaps, neither a product defect.** First,
`skipDeployment: !isAdapterTest`: ten e2e files gate on `NEXT_ENABLE_ADAPTER`, and
unset they report a pass in ~5s having deployed nothing — which is how
`partial-fallback-shell-upgrade` "passed" in 5.361s and then produced four real
failures once the flag was set. Second, and the reason those failures existed at
all: the PPR tests split a response on a literal `<!-- PPR_BOUNDARY_SENTINEL -->`
chunk that `app-page-runtime.ts` emits only under `__NEXT_TEST_MODE`, which
`define-env.ts` inlines at build time. Unset, the branch is dead-code eliminated,
the whole document lands in `staticPart`, and every "this should only be in the
dynamic part" assertion fails. Vercel passes `--build-env
NEXT_PRIVATE_TEST_MODE=e2e`; `e2e-deploy.sh` now exports the same thing. That one
env var is the whole explanation for `partial-fallback-root-blocking` (1 of 1),
`partial-fallback-shell-upgrade` (4 of 7) and `sub-shell-generation` (6 of 7).

**Two open bugs added, neither root-caused.**
`parallel-routes-root-param-dynamic-child` (10 of 14) times out on
`waitForSelector('#reveal')` — a client-component checkbox in a root-params app
with no `app/layout.tsx` — with resource 404s in the browser log.
`incremental-cache-path-traversal` (1 of 1) answers 500 where upstream expects a
200 rendering the traversal segments as literal params; nothing leaks, so it is a
fidelity gap rather than a security one. It is also a screen false positive worth
knowing about: its `describe.skip` is conditional on `__NEXT_CACHE_COMPONENTS`,
which the harness does not set, so the file does run.

Coverage record: 72 files screened, 43 whole files in `rules.include`, 3 more in
part, 12 fixed defects, 3 open bugs (`assetPrefix`,
`parallel-routes-root-param-dynamic-child`, `incremental-cache-path-traversal`),
454 candidates left.

### The optional-catchall fix, finished offline

`app-dir/layout-params` failed *identically* after the `repairRouteParamQuery` fix
of the previous entry — same case, same message, on both retries — with the fix
verifiably present in the deployed bundle. Rather than iterate through 3-minute
deploys, the fixture was built and served locally: copied into the next.js checkout
as `lp-app` (module resolution has to walk up to the repo's `node_modules/next`,
so `/tmp` will not do), with `node_modules/cdk-nextjs/{package.json,lib/adapter/*}`
placed inside the app exactly as `e2e-deploy.sh` does, then served twice off the
same build — once by `next start`, once by our container shell pointed at
`.next/cdk-nextjs-adapter/app`. Side by side:

```
next start:      <div id="lvl2-layout"></div>
container shell: <div id="lvl2-layout"><div id="lvl2-params">["undefined"]</div></div>
```

`["undefined"]` — the literal string — not the `[""]` the earlier fix was written
against. Instrumenting the shell where it hands `req.url` to the entrypoint gave
the actual shape: `resolveRoutes` returns `{ nxtPparams: undefined }` in *both*
`routeMatches` and `resolvedQuery`. The key is present with no value, which neither
`Record<string, string>` nor `ResolveRoutesQuery` admits and which
`JSON.stringify` erases — so the first attempt looked for `""`, found nothing, and
the `undefined` survived into `URLSearchParams.append`, which stringified it.

The fix is the same pass, with the predicate corrected to "neither side filled
this param" and the `routeMatches` type widened to admit the value it actually
carries. All six of the file's assertions now match `next start` offline. The
offline harness is worth remembering: one deploy's worth of wall clock bought an
instrumentable server, and the defect was legible in minutes.

Also banked from a live probe: `parallel-routes-root-param-dynamic-child` is not a
hydration failure. `/en` returns a prerendered **404** while all seven of its
script `src`s return 200, so the `#reveal` timeout is downstream of a routing miss
on a root-param route with no `app/layout.tsx`. Recorded in
`docs/harness-coverage.md`; still open.

### Two more harness defects: draft-gated prerenders, and unseeded fallback shells

Both of the failures banked in the previous entry are now fixed, and neither was
what its symptom suggested.

**`parallel-routes-root-param-dynamic-child` (defect 13).** The `/en` 404 is a
deliberate contract, not an accident. A *root params* app — `app/[locale]/page.tsx`
with `generateStaticParams()` and no `app/layout.tsx` — has params that can never be
filled from a request, so next.js emits its `dynamicRoutes` rule gated on draft
mode (`has: [{cookie __prerender_bypass}, {cookie __next_preview_data}]`): invoke
the function only for a draft request, otherwise serve the prerender. Vercel's CDN
serves it; our manifest never listed `/en`, so dispatch matched nothing.

`addPrerenderTemplates` in `src/adapter/build-outputs.ts` is now
`addPrerenderPathnames` and takes `ctx.routing.dynamicRoutes`. It registers a
*concrete* prerender pathname when a gated rule matches it and no ungated one does
— `onlyGatedRulesMatch` — owned by the entrypoint of `prerender.route`, preferring
that route's `.rsc` entrypoint for an `.rsc` pathname. The narrowing is load-bearing:
registering every concrete prerender adds four inert
`/index.segments/*.segment.rsc` keys for app-playground (a dispatch probe with
`Next-Router-Segment-Prefetch` confirms `/` never resolves to them), and a route
with an ungated rule already reaches its template, where `RouteModule.prepare`
re-derives params from the pathname. Unit-tested by gating app-playground's
`/isr/[id]` rules; the three committed fixtures still produce byte-identical
manifests. Verified at the dispatch level against the real fixture's captured build
context — `/en`, `/fr`, `/en.rsc`, `/en/gsp/stories/static-123` resolve, `/xx` still
404s like `next start`. End-to-end needs a deploy: offline the runtime cache is
S3-only, so a fully prerendered route answers `invariant: cache entry required but
not generated`.

**`sub-shell-generation` (defect 14).** Six of seven cases disagreed with
`next start` on one sentinel — `Root Layout: (runtime)` where the fixture's
`'use cache'` layout should report `(buildtime)`. The seeding loop in
`src/adapter/adapter.mts` skipped every prerender group whose pathname contained
`[`, on the comment that templates "don't have actual content". With PPR a template
*is* the route's fallback shell, and the server looks it up under that literal key:
`app-page-runtime` reads `prerenderManifest.dynamicRoutes[route].fallback` (the
template string verbatim) and calls
`routeModule.handleResponse({ cacheKey, isFallback: true })`; the Pages Router does
the same with `srcPage` for an ISR fallback. Every such lookup missed, so the shell
was re-rendered per request instead of resumed.

Dropping the skip seeds them. Non-PPR templates stay out for free — a route with no
shell emits no prerender output, and a Pages Router template gets no kind from
`getRouteToCacheKindMap` and is skipped one line later. Measured with
`scripts/e2e-offline.sh app-dir/sub-shell-generation`: the seed directory gains
`[lang]/[slug].json`, `en/[slug].json` and `fr/[slug].json`, each with its
`postponed` state and the exact shell the per-URL expectation table asks for (the
`[lang]` shell defers the lang layout; the locale shells bake it in). `adapter.mts`
has no jest coverage, so that fixture build is the evidence.

`scripts/e2e-offline.sh` is committed with this step — it is what made both of these
tractable, and both entries above were measured with it.

Both files stay out of `rules.include` until a deployed re-run is green; the same is
true of `layout-params`, whose fix is committed and offline-verified.

### The three fixed files, verified deployed

Ran `layout-params`, `parallel-routes-root-param-dynamic-child` and
`sub-shell-generation` against `hrns-shared` — all three green on attempt 0, 160s /
180s / 164s, `exiting with code 0`. So defects 11, 13 and 14 are confirmed against a
real deployment, not just offline, and all three files are now in `rules.include`
(46 whole files; `screening` regenerated, candidates 454 → 452).

Correction recorded in `docs/harness-coverage.md`: the `NEXT_PRIVATE_TEST_MODE`
section previously attributed all six `sub-shell-generation` failures to the missing
build env var. The var fixed the *shape* of the failure (dynamic elements landing in
the static half); the six cases then failed again on the shell's own sentinel, which
was defect 14. A missing env var and a real defect can share a file — the tell is
that the shape changes.

### Batch 8: 15 more files green, one defect, and a broken bundle

Sixteen candidate files deployed against `hrns-shared`. Fifteen green, one failure.
`rules.include` is now 61 whole files and `screening` is regenerated: candidates
452 → 438. The green fifteen, with what each buys:

`actions-revalidate-remount`, `app-catch-all-optional`, `app-routes-client-component`,
`conflicting-search-and-route-params`, `dynamic-requests`, `external-redirect`,
`forbidden/basic`, `global-not-found/basic`, `hello-world`,
`interception-routes-root-catchall`, `metadata-image-files`,
`metadata-static-file-root-route`, `metadata-svg-icon`,
`partial-fallback-root-blocking`, `partial-fallback-shell-upgrade`.

The last two are the deployed confirmation of defect 14 — they are PPR
fallback-shell fixtures, and they were the two files whose sentinel fix had been
recorded as "pending a re-run".

The failure was `404-page-app`, 2 of 2 on both attempts, and it is defect 15:
`resolveNotFoundTarget` checked `/_not-found`, then `/_error`, then a *static*
`/404`, so a Pages Router app whose `pages/404.js` is invocable rather than
prerendered got the framework's built-in "404: This page could not be found"
instead of its own page. next's own order is `/_not-found`, `/404`, `/_error`
(`base-server.ts`, `renderErrorToResponse`). Fixed by adding `/404` to the
entrypoint loop; covered by a new `dispatch.test.ts` case that also pins
`/_not-found` still winning when an app has all three. Offline, `/abc` now
renders `Hi There` with a 404 status, matching `next start`. The file is queued
for batch 9 rather than added to `rules.include`.

Incidental, found while re-bundling for that verification: **`pnpm bundle` was
broken at HEAD.** `src/adapter/build-outputs.ts` imports `createRequire` by name
and is in the adapter bundle's module tree, so the adapter/cache-handler banner
declaring the bare `createRequire` produced output that fails to parse —
`node --check lib/adapter/adapter.mjs` reports "Identifier 'createRequire' has
already been declared". `.projenrc.ts`'s `cjsGlobalsBanner` already documents this
exact hazard and prefixes its imports for it; `createRequireBanner` was the one that
did not. Now prefixed too. It only escaped notice because the offline script copies
the previously built `lib/` rather than rebuilding it.

### Where the harness stands

438 candidates left, ~425 of which have never been deployed; at the observed
~2.7 min/file that is ~19 hours of wall clock to sweep once. The pool is long and
thin — 1010 `it()` cases over 438 files — so the remaining yield is mostly in the
dense files (`next-image-legacy/default` alone is 44 cases). Defect rate is
falling: batches 5-7 found 4 defects across 23 files, batch 8 found 1 across 16.

### The scheduled harness run goes weekly, Sunday 14:00 UTC

`docs/plans/adapter-runtime-release.md`'s step 8 says "nightly"; at the user's
direction the schedule in `.github/workflows/e2e-harness.yml` is now
`0 14 * * 0` instead of `0 6 * * *`. Daily was overkill: a run ships a
deployment per test file, and nothing in next.js's suite changes between two
consecutive days that a run would catch. `e2e-tests.yml` remains the per-commit
gate on all four `NextjsType`s, so the harness is not the thing standing between
a commit and a release.

14:00 UTC is morning on both US coasts, and the job's 180-minute ceiling puts the
result inside Sunday — ready to read Monday morning, which is the point. The
sweep job shares the trigger, so leftover stacks are still collected on the same
cadence. Wording updated in `scripts/e2e-harness/README.md` (two places) and
`docs/harness-coverage.md`.

### Defect 16: a path-style `assetPrefix` 404'd every bundle

The top open bug in `docs/harness-coverage.md`, blocking `app-dir/asset-prefix`
(7 cases) and `app-dir/asset-prefix-with-basepath` (7 cases). Next.js emits every
bundle URL as `<assetPrefix>/_next/static/...` while the objects keep their
`<basePath>/_next/static/...` S3 keys, so CloudFront's `_next/static*` behavior
missed, the request fell through to the compute origin, and 404'd — the deployment
package deliberately carries no `.next/static`.

The one non-obvious thing: `assetPrefix` is applied *on top of* `basePath`, not
under it. An app with both emits `/custom-asset-prefix/_next/static/x` for an
object keyed `custom-base-path/_next/static/x`. The prefix therefore cannot be
joined with `basePath`, and an S3 origin keys on the request URI — `originPath`
only prepends — so a viewer-request CloudFront Function is the only place that can
map one onto the other.

What landed:

- `readNextConfigAssetPrefix` in `src/utils/base-path.ts`, reading the same
  `required-server-files.json` that `basePath` comes from. An absolute or
  protocol-relative prefix reduces to `""`: it names an origin cdk-nextjs does not
  serve. No warning when the file is missing — `readNextConfigBasePath` already
  warns about that, and no `assetPrefix` is the common case.
- `NextjsBuild.nextConfigAssetPrefix`, passed by both Global root constructs to
  `NextjsDistribution` as a new `assetPrefix` prop.
- `NextjsDistribution.addAssetPrefixBehavior`: a `<assetPrefix>/_next/static*`
  behavior on the static origin plus the rewrite function. `resolveAssetPrefix`
  drops the prefix when it equals `basePath` (Next.js's own default when `basePath`
  is set), which would otherwise be a duplicate pattern CloudFront rejects. The
  behavior budget counts it, so the error message stays accurate.
- `NextjsBaseConstruct.warnUnservedAssetPrefix`: the regional `NextjsType`s cannot
  serve a path-style prefix — API Gateway's `_next/static` resource and a
  container's own files both sit at the unprefixed path — so synth warns rather
  than deploying something that 404s. Fixing them properly would mean a second
  API Gateway resource tree and a runtime URI strip; not worth it until someone
  asks.
- `README.md` gained a "`next.config.js` options cdk-nextjs reads" section
  covering both `basePath` and `assetPrefix`. `assetPrefix` was undocumented.

Verified with `pnpm compile`, the full `pnpm jest` (370 tests), and `pnpm eslint`.
The two fixture files are not in `rules.include` yet — they go into the next
deployed batch, which is where the fix gets its real evidence.

### The harness reported the wrong `DEPLOYMENT_ID`

`app-dir/mdx` failed 2 of 25 cases in batch 9 on both attempts, expecting
`/_next/image?url=%2Ftest.jpg&w=384&q=75&dpl=hrns-shared` and getting
`…&dpl=next-test-1790129321350-532-29a15df9`. Not a runtime defect: `next build`
inlines `NEXT_DEPLOYMENT_ID` into every asset URL, and `scripts/e2e-deploy.sh`
sets that per *app directory* (deliberately — with one shared stack the stack name
is a constant, and two builds sharing a deployment ID is the skew the variable
exists to detect) while the marker line it writes for
`parseIdsFromCliOutput` reported `$STACK_NAME`. The harness then compared the
app's URLs against a value the app never emitted.

The marker now reports `$NEXT_DEPLOYMENT_ID`, which is what next.js's own fixture
`post-build` prints (`test/lib/next-modes/base.ts`). Nothing in cdk-nextjs reads
`?dpl=`, so the stack name was never needed here. `mdx` goes into a later batch to
confirm.

### The harness paid a full CloudFormation deploy on every single file

Batch 9's log gave the number: of 22 deploy invocations, **19 fell back with
`NextjsNextjsCacheBucket... rejected changes: Tags`** and 3 with
`DistributionConfig`. Zero hotswapped. The hotswap attempt took 0.77s before
giving up, and the full deploy that followed took ~110s of a ~157s median green
file — so most of the wall clock of every harness run was avoidable.

The cause is a CDK behavior that is easy to miss: `BucketDeployment`
unconditionally tags its *destination bucket*
`aws-cdk:cr-owned:<destinationKeyPrefix>:<hash>`
(`aws-cdk-lib/aws-s3-deployment/lib/bucket-deployment.js`,
`CUSTOM_RESOURCE_OWNER_TAG`). `NextjsCache` passed the build ID as that prefix, so
the cache bucket's `Tags` changed on every fixture — and `AWS::S3::Bucket` `Tags`
are not hotswappable. The static assets bucket never had the problem: its prefix
is `basePath`, which is stable.

The fix keeps the S3 keys byte-identical and makes the tag constant: stage the
init cache into a temp directory under a `<buildId>/` subdirectory and drop
`destinationKeyPrefix`. A copy rather than the directory itself because the build
ID is only known *after* `next build` (so the adapter cannot write into a nested
directory), and because `.next/cdk-nextjs-init-cache` has to stay where
`CDK_NEXTJS_INIT_CACHE_DIR` and the local cache handler expect it. CDK reads every
byte of the tree to zip it regardless, so the copy is not a new cost.

Why this is functionally neutral, which was the thing worth checking before
touching a cache the runtime depends on:

- `prune` was already `false`, so nothing used the prefix to scope a prune —
  pruning is the post-deploy Lambda's job.
- The two handler branches that *do* scope work to the prefix — emptying it on
  Delete via `bucket_owned`, and `aws s3 rm --recursive` of the old prefix when
  the destination changes on Update — are both gated on `retain_on_delete`
  (`bucket-deployment-handler/index.py:129,134`), which the handler defaults to
  `true` and `BucketDeployment` leaves unset. Dead code for us either way.
- So the only live consumer was the `s3_dest` the sync writes to, and the staged
  tree reproduces it exactly.

Incidental: the 104-character `destinationKeyPrefix` limit no longer applies, and
`overrides.bucketDeploymentProps.destinationKeyPrefix` changes from *replacing*
the build ID to *prepending* to keys that already carry it. Both break the
runtime; unsupported either way.

`scripts/e2e-harness/README.md` claimed the opposite of all this — "the cache
bucket's `Tags` never blocked a deploy in practice, 7 of 9 deploys hotswapped",
from an earlier 13-file measurement. That was wrong, and read literally it argued
against this fix, so its table is replaced with batch 9's numbers and the note
that the distribution's cache behaviors are now the only remaining blocker.
`scripts/e2e-deploy.sh`'s "expect the fallback most of the time" comment goes with
it.

Two new cases in `src/nextjs-cache.test.ts`: the deployment has no
`DestinationBucketKeyPrefix` *and* the staged asset still has a `<buildId>/`
directory (either assertion alone would pass while the keys moved), and the cache
bucket's `aws-cdk:cr-owned:` tag set is identical across two different build IDs.
Verified with `pnpm compile`, the full `pnpm jest` (393 tests) and `pnpm eslint`.

### Batch 9's verdicts: 11 more files in, and three "failures" that were only slow

Batch 9 ran 23 harness files against `hrns-shared`. Eleven came back green and are
now in `test/deploy-tests-manifest.json`'s `rules.include` (61 → 72), with a row
each in `docs/harness-coverage.md`'s Passing table: `404-page-app`,
`app-dir/default-error-page-ui`, `app-dir/javascript-urls`,
`app-dir/parallel-route-not-found`, `app-dir/static-generation-status`,
`app-dir/use-cache-metadata-route-handler`, `app-dir/use-router-bfcache-id`,
`auto-export`, `invalid-href`, `link-ref-app`, `router-is-ready`.
`node scripts/e2e-harness/screen.mjs --next ../next.js --write` regenerated the
`screening` block: 72 included, 424 candidates.

Of the eleven failures, four are not defects:

- `script-loader`, `src-dir-support` and `trailing-slashes-href-resolving` threw
  `Exceeded timeout of 240000 ms for a hook` out of `beforeAll` — 39 occurrences
  between them — and were the three slowest files in the run (1153s, 985s, 635s).
  Nothing under test ran. Read the duration, not the case names: `src-dir-support`
  reports 8 of 8 "routing" cases failing and not one of them executed. These are
  the files the cache bucket's churning `Tags` timed out, so they are requeued
  rather than diagnosed.
- `app-dir/mdx` (2 of 27) was the harness reporting `$STACK_NAME` as
  `DEPLOYMENT_ID` where next.js compares against the `?dpl=` the build inlined.
  Fixed in `scripts/e2e-deploy.sh` and requeued.

The other seven are real and unexplained, so they get a new
`## Failing — awaiting a verdict` section rather than an `excluded-notes` entry —
an `excluded-notes` entry is a decision, and no decision has been made. Recorded
with case counts and the failing assertion so the next session starts from the
symptom: `new-link-behavior` (2/7) and `legacy-link-behavior-pages` (2/8) both see
an empty `<a>` text where a label is expected, which is one suspected cause;
`prerender-preview` (1/9) and `preview-fallback` (1/6) are both preview/draft
mode, which is a second; then `app-document/rendering` (1/10),
`i18n-support-catchall` (1/4) and `next-image-legacy/default` (1/28, so not the
image optimizer wholesale).

Also reworded the manifest's `app-dir/asset-prefix` note: it said "Excluded as an
OPEN BUG", but defect 16 fixed it. It now says the file stays out of
`rules.include` only until a deployment says it is green, which batch 10 is
currently establishing.

### Six unrelated-looking failures were one bug: every Pages Router `/` 404'd

Batch 9 left seven files failing for reasons nobody had established. Six of them
turned out to share a cause, and none of the six symptoms pointed at it:
`new-link-behavior` saw `$('a').text()` come back `""`, `prerender-preview` and
`preview-fallback` threw `SyntaxError: Unexpected end of JSON input`,
`app-document/rendering` read a `#css-in-cjs-count` of `0` where `2` was expected,
`next-image-legacy/default` got `naturalWidth: null`, `legacy-link-behavior-pages`
matched `new-link-behavior`. What they share is the URL: each failing case is the
only one in its file that requests `/`, and every other case in the same file
passed. `/` was serving the built-in 404 page, which is itself a Next.js document —
so it hydrates, and the only clue in the browser log is one "Failed to load
resource: 404".

`/` was not a pathname we knew about. `next build`'s adapter hook derives every
Pages Router pathname with `normalizePagePath(page)`, and `normalizePagePath("/")`
is `"/index"`. The home page therefore arrives as `pathname: "/index"` — as a
`PAGES` output when it has `getStaticProps`/`getServerSideProps`, and as a
`STATIC_FILE` when automatic static optimization prerendered it, in which case
there is no `PAGES` output at all. `manifest.pathnames` is the union of the
entrypoint and static-file keys and `resolveRoutes` can only resolve a pathname in
it, so `/` resolved to nothing and dispatch fell through to the 404 ladder.

`routablePathnames` (`src/adapter/build-outputs.ts`) maps a reported
`${basePath}/index` to `basePath || "/"`, and both `collectStaticFiles` and
`addEntrypoint` now register the real pathname alongside the reported one. Three
things made this safe to do by exact match:

- `normalizePagePath("/index")` is `"/index/index"`, so a reported `/index` can
  only have come from the page `/`. There is no collision to resolve.
- The same page's data route (`/_next/data/<buildId>/index.json`) and an App Router
  `/index.rsc` are real URLs, and an exact match leaves them alone.
- App Router reports its home page as `/` already, which is why 72 files passed
  with this bug in place.

`/index` is kept as well as `/` because next's minimal mode — the mode the runtime
runs in — rewrites `req.url` and `x-matched-path` from `/index` to `/` before
matching (`base-server.ts`), so dropping it would be a divergence in the other
direction. `collectStaticFiles` now sorts its keys on the way out instead of
sorting the outputs on the way in, since one output can produce two keys and the
manifest has to stay byte-stable.

Three new cases in `build-outputs.test.ts`: the static home page, the invocable
one, and the `basePath` form (`/prod`, not `/prod/`). `pnpm jest` is 396 tests
green, `pnpm compile` and `pnpm eslint` clean.

Recorded as defect 17 in `docs/harness-coverage.md`, which leaves exactly one file
awaiting a verdict: `i18n-support-catchall`, whose `/` answers 308 where the test
expects 200. That one resolves `/` and redirects it, so it is a different cause —
though worth re-measuring after this, since this changes what `/` resolves to.

The six files are queued for a deployed re-run and stay out of `rules.include`
until they come back green. Not bundled yet: batch 10 is mid-run and swapping
`lib/adapter/adapter.mjs` underneath it would leave half the run built against a
different adapter.

### Batch 10's verdicts: 15 more files in, and defect 17 confirmed five more times

Batch 10 was 20 files against the shared `hrns-shared` deployment: 15 green, 5
failing. `rules.include` goes 72 → 87, `candidates` 424 → 409.

The 15 green files are in `docs/harness-coverage.md`'s passing table with one-line
descriptions. Two of them are deployed evidence for fixes that only had local
evidence before:

- **Defect 16 (`assetPrefix`) is confirmed.** `app-dir/asset-prefix` and
  `app-dir/asset-prefix-with-basepath` both passed 7 of 7 on attempt 0. The
  `excluded-notes` entry for the first one is deleted — it existed only to say
  "fixed but not yet proven against a deployment".
- **The `DEPLOYMENT_ID` marker fix is confirmed.** `app-dir/mdx` passed 27 of 27,
  where it had failed 2 of 27 because `scripts/e2e-deploy.sh` printed
  `$STACK_NAME` and next.js compares against the `?dpl=` the build inlined.

All 5 failures are defect 17 — this batch was deployed before that fix was bundled,
so it is five more independent sightings, not a regression. `next-head` (4 of 5),
`next-image-legacy/unicode` (5 of 5), `no-page-props` (2 of 5) and
`rewrites-client-resolving` (5 of 5) all start every failing case at
`next.browser('/')`; `next-head` asserts on the whole `<head>` and printed the 404
document's `<title>` straight into the jest diff. That takes defect 17's file list
from six to eleven.

One case in `async-modules` is not defect 17 and is now the second file awaiting a
verdict: "can render async error page" requests `/make-error`, whose
`getServerSideProps` throws, and gets a bare `text/plain` `500 Internal Server
Error` instead of the app's `pages/_error`. `src/runtime/core.ts` has no error
ladder analogous to `sendNotFound` — a throw out of an entrypoint handler reaches
`failWith`, which writes the plain-text 500. Unconfirmed on purpose: the same
file's other two failures were defect 17, so this case gets re-measured against the
fix before its cause is settled.

The cost picture from this run, which is what makes "keep going until the pool is
empty" tractable: the first file took 238s making the one transitional
CloudFormation change that swapped the cache bucket's tag key, the second 216s, and
every file after that ran 100–140s except two slow fixtures
(`instrumentation-client-hook` at 677s and `typescript-paths` at 199s, both
passing). ~395 undeployed candidates at ~120s is ~12 hours of wall clock.

Batch 9's three `createNext`-timeout files did not make it into this batch; they are
still requeued, now alongside the eleven defect-17 files.

### Batch 11's verdicts: defect 17 confirmed, defect 18 found, and a screening hole closed

Batch 11 ran 50 files (2026-09-23), the first batch deployed with defect 17's fix
bundled into the adapter. 32 came back green and went into `rules.include`, taking
it from 87 to 119.

**Defect 17 is confirmed.** Eight of its eleven files are now green:
`new-link-behavior`, `legacy-link-behavior-pages`, `prerender-preview`,
`preview-fallback`, `app-document/rendering`, `next-image-legacy/default`,
`next-head` and `rewrites-client-resolving`. Of the other three,
`next-image-legacy/unicode` never deployed at all (defect 18, below), and
`async-modules` and `no-page-props` each kept exactly one failing case with a
different cause — both now awaiting a verdict in `docs/harness-coverage.md`.

**Defect 18: a space in a `public/` filename failed the whole synth.**
`next-image-legacy/unicode` ships `public/hello world.jpg`, and
`NextjsDistribution` threw rather than produce a CloudFront path pattern for it, so
the app could not be deployed at all — not one of its cases ran. CloudFront's path
pattern alphabet is `A-Z a-z 0-9 _ - . * $ / ~ " ' @ : +` and `&`, plus the `*` and
`?` wildcards: no space, and no `%` either, so the percent-encoded form the request
actually arrives as (`/hello%20world.jpg`) is equally unspellable. The fix in
`src/nextjs-distribution.ts` substitutes one `?` per character of the encoded form
(`hello???world.jpg`), which is the narrowest pattern CloudFront can express, and
throws only when the result exceeds the 255-character limit — with a message that
says to rename the file or nest it.

`NextjsRegionalFunctions` had the same exposure one layer down: an API Gateway
resource path part allows only `[a-zA-Z0-9:._-$]`, so `addResource` threw on the
same file. There the resource tree genuinely cannot express it, so `src/nextjs-api.ts`
warns and skips that one entry — the asset 404s, the app deploys — following the
`warnOnTrailingSlashGroups` precedent in the same construct. Four new tests cover
both paths; 22 suites / 400 tests green, `pnpm compile` and `pnpm eslint` clean.
`next-image-legacy/unicode` is requeued behind a `pnpm bundle`.

**Thirteen files "passed" in under 4 seconds having deployed nothing.** Every
`app-dir/cache-components-errors/*` file calls `nextTestSetup({ skipDeployment: true })`
through a sibling `shared.util.ts`, or is a two-line `require('./client.test')`
wrapper around one that does, so the existing test-file-only regex never saw it.
`scripts/e2e-harness/screen.mjs` now follows relative `import`/`require` specifiers
two levels deep for that one screen — the two shapes above are exactly what two
levels buys. Candidates fell 373 → 341, saving ~72 minutes of deploys that would
have proved nothing. Deliberately scoped to this screen: `skipDeployment: true` in a
shared helper replaces every caller, so following the import cannot over-report,
whereas a helper's `isNextDev` branch may cover only some of a caller's cases.

Four files now await a verdict: `i18n-support-catchall` (1/4, `/` answers 308),
`async-modules` (1/7, the plain-text 500 above), `no-page-props` (1/5, a navigation
reads `undefined` where it expects `"hi"`) and `asset-prefix-absolute` (1/1, bundles
404 under an absolute `assetPrefix` pointing at a second origin the fixture serves
itself).

### Defect 19: a throw out of a route never reached the app's error page

Root-caused while batch 12 deployed. `async-modules`'s last failing case
("can render async error page") requests `/make-error`, whose `getServerSideProps`
throws, and the fixture's `pages/_error` renders "hello error" — we answered
`500 Internal Server Error` as `text/plain`.

Next.js's page handlers catch, report and then deliberately rethrow ("rethrow so
that we can handle serving error page", `pages-handler.ts`), which puts the error
page on the host, exactly as `render404` puts the 404 on the host. cdk-nextjs had no
counterpart: every throw hit one `failWith` that wrote a plain-text 500, so
`pages/_error`, `pages/500` and the `500.html` next prerenders by default were all
unreachable — in every app, not just this fixture.

`resolveErrorTarget` (`src/runtime/dispatch.ts`) now resolves the ladder once from
the manifest in `base-server.ts`'s own order — invocable `/500`, prerendered `/500`,
`/_error`, nothing — and `NextjsRuntime.sendError` walks it. It sets the 500 before
invoking, because `_error`'s `getInitialProps` reads `res.statusCode` for its own
prop, and renders for the URL that was asked for rather than for `/_error`. The
target lives on the runtime rather than the Dispatcher, which is per request: the
throw it answers can happen before one exists.

Three things the fallback also does now: survive an error page that throws in turn
without recursing; strip a `Content-Length`/`ETag` the failed render left describing
a body that never arrived; and send `Cache-Control: private, no-cache, no-store,
max-age=0, must-revalidate`, so a long-lived `Cache-Control` from the render that
threw cannot get a 500 cached at the edge.

Four `resolveErrorTarget` cases in `dispatch.test.ts` and four in `core.test.ts`;
22 suites / 407 tests green, `pnpm eslint` clean, `tsc --noEmit` clean. Not yet
bundled — `pnpm bundle` has to wait for batch 12 to finish — so `async-modules` is
requeued alongside `next-image-legacy/unicode` behind the next bundle. Three files
still await a verdict: `i18n-support-catchall`, `no-page-props` and
`asset-prefix-absolute`.

### Defect 20: every i18n app answered `/` with a redirect

The second of the three awaiting-verdict files root-caused without a deployment.
`i18n-support-catchall`'s failing case is `next.fetch('/', { redirect: 'manual' })`
expecting a 200; we answered a 308 to `/en-US`. The fixture's root catch-all turned
out to be irrelevant — this was every app with an `i18n` config, at `/`.

`@next/routing` prefixes the locale by concatenation, `${basePath}/${locale}${pathname}`,
so the root becomes `/en-US/`; the `priority` slash-stripping 308 that `next build`
always compiles into `routing.beforeMiddleware` then matched that invented path and
redirected before anything looked for a page. next's own router special-cases the
same shape (`resolve-routes.ts`: ``pathname === '/' ? `/${defaultLocale}` : …``).

Two measurements pinned it. A unit dispatch against the committed `pages-i18n`
fixture reproduced the 308 with no AWS at all, and `scripts/e2e-offline.sh` gave the
oracle: `next start` on a plain build of the fixture answers `/`, `/en-US`, `/fr`,
`/nl-NL` and `/another` with 200, and answers `/` with `accept-language: nl` with a
307 to `/nl`. (Note for next time: `next start` on an *adapter* build of that fixture
404s everywhere, so the offline script's second URL is only an oracle when the build
it serves was made without `NEXT_ADAPTER_PATH`.)

The same concatenation builds the location of the locale-detection 307, so that
redirect was wrong twice: `https://example.test/nl-NL/` where next sends `/nl-NL`.

Two narrow pieces in `src/runtime/dispatch.ts`. `Dispatcher.withRootLocale` does the
prefixing itself for a root request, and only when the locale asked for is already
the domain-aware default — no redirect owed, so `resolveRoutes` sees a locale in the
path and leaves it alone. A root request detecting a *different* locale is passed
through untouched, so its 307 still comes out of `resolveRoutes` after middleware has
had the request, which is next's ordering. `Dispatcher.normalizeRedirectLocation`
then puts every same-origin location in the form next sends — a path, without the
stray slash — while leaving a cross-origin `i18n.domains` location absolute.

Four new cases in `dispatch.test.ts` (root with no redirect, the detection 307, the
cross-domain 307, and a trailing slash the request really carried). One existing
expectation changed with it: a middleware `NextResponse.redirect()` to a same-origin
URL now reports `/login` rather than the absolute URL, which is what next puts on the
wire (`@next/routing` already relativizes the header it sets; only the `redirect.url`
field kept the absolute form). 22 suites / 410 tests green, `pnpm eslint` and
`tsc --noEmit` clean.

Still not bundled — batch 12 is mid-flight — so `i18n-support-catchall` joins
`async-modules` and `next-image-legacy/unicode` in the requeue behind the next
bundle, and `app-dir/not-found-with-pages-i18n` (the one i18n file already in
`rules.include`) goes with them to confirm no regression. Two files await a verdict:
`no-page-props` and `asset-prefix-absolute`.

### Defect 21: a static `getStaticProps` page's data route 404'd

`no-page-props` (1 of 5) was the last batch-11 failure with an unexplained
assertion: click a link to `/gsp`, read text off the page, get `undefined` instead
of `"hi"`. Diagnosed entirely offline, no deployment. Recipe, since it is now the
standard one: `scripts/e2e-offline.sh no-page-props 3112` for our runtime, plus a
second copy of the same fixture built *without* `NEXT_ADAPTER_PATH` and served with
`next start` as the oracle (an adapter build is not an oracle — see defect 20).

```
ours   /_next/data/<buildId>/gsp.json   404 text/html
oracle /_next/data/<buildId>/gsp.json   200 {"__N_SSG":true,"pageProps":{"hello":"world"}}
both   /_next/data/<buildId>/gssp.json  200 {"__N_SSP":true,…}
```

`/gssp` worked because a `getServerSideProps` page's data route is an output in its
own right. `/gsp`'s is not: `next build` emits a `dynamicRoutes` rule for a data
route only when the page is dynamic or the app has middleware
(`build-complete.ts`, `needsMiddlewareResolveRoutes`, which is the same flag it
hands us as `routing.shouldNormalizeNextData`). Without middleware, a static
`getStaticProps` page's data route reaches us only as a concrete `prerenders`
pathname with no template and no rule, and Next.js expects the platform to serve it
as an output keyed by pathname. `addPrerenderPathnames` skipped it, and the Pages
Router's `.json` fetch on every client-side navigation 404'd, degrading the
navigation to a full page load — which is what lost the state the assertion read.

Fix in `src/adapter/build-outputs.ts`: `addPrerenderPathnames` takes the data-route
prefix (`${basePath}/_next/data/${buildId}/`) and registers a concrete `…json`
prerender against its owning route's entrypoint when **no ungated rule matches it**.
The narrowing matters and was the second version of the fix: registering every
concrete data pathname also caught a dynamic page's
`/_next/data/<id>/en-US/blog/hello.json`, which the ungated `…/blog/[slug].json`
rule already reaches — and that rule is where `nxtPslug` comes from, so resolving
the request to itself would silently drop the param. Same failure mode the doc
comment already records for `/isr/1`.

Verified by rebuilding the fixture against an esbuild bundle of the changed adapter
written to `/tmp` (not `lib/`, because batch 12 is still deploying from `lib/`):
`gsp.json` and `gssp.json` both 200 and byte-identical in shape to the oracle. One
new `build-outputs.test.ts` case asserts both halves — the static data route in, the
dynamic concrete one out. 22 suites / 411 tests green, `pnpm eslint` and
`tsc --noEmit` clean.

Requeue behind the next bundle now stands at `next-image-legacy/unicode` (18),
`async-modules` (19), `i18n-support-catchall` (20), `no-page-props` (21), plus
`app-dir/not-found-with-pages-i18n` and `app-dir/app-basepath` as regression checks
(i18n, and a basePath app whose data-route prefix the fix now depends on). One file
still awaits a verdict: `asset-prefix-absolute`.

### Defect 22: an absolute `assetPrefix` with a path 404'd every bundle

`asset-prefix-absolute` (1 of 1) was the last file awaiting a verdict, and the only
one where "defect or fixture assuming a deployment shape we do not provide" was a
real fork. The fixture sets `assetPrefix:
'https://example.vercel.sh/custom-asset-prefix'` and re-requests each script's
*path* against the deployment (next's test helper keeps only `pathname`/`search`
from an absolute URL, which is what the test's "remove hostname" comment means).

`next start` settled it. `next build` compiles a rewrite of its own into
`beforeFiles` for any path-carrying `assetPrefix`, absolute included —
`/custom-asset-prefix/_next/:path+ → /_next/:path+` — and a plain build serves
`/custom-asset-prefix/_next/static/chunks/<name>.js` with 200
`application/javascript` while `/custom-asset-prefix/bogus/_next/static/...` is 404.
So the path is genuinely ours to answer. The rewrite is in our manifest too
(`routing.beforeFiles`, persisted verbatim), so the runtime would apply it — but
`_next/static` never reaches the runtime: those objects are in S3, CloudFront had no
behavior for `/custom-asset-prefix/*`, and the request fell through to the compute
origin, which carries no `.next/static` at all.

The behavior that fixes it already existed (`NextjsDistribution.addAssetPrefixBehavior`,
from the path-style case) — it just never saw this prefix, because
`readNextConfigAssetPrefix` reduced every absolute `assetPrefix` to `""`. Split the
reader in two rather than changing its meaning:

- `readNextConfigAssetPrefix` unchanged: path-style only, `""` for absolute. It
  drives `warnUnservedAssetPrefix`, and that warning must *not* fire for an absolute
  prefix — pointing one at a CDN you front the assets bucket with is the documented
  supported setup, so warning there would be a wrong warning on the happy path.
- `readNextConfigAssetPrefixPath` new: the path portion of either form, via a shared
  `assetPrefixPath` helper that `NextjsDistribution.resolveAssetPrefix` now uses as
  well (its `assetPrefix` prop is public, so a user can hand it either spelling).
  The two Global root constructs pass this one to the distribution.

`https://cdn.example.com/cdn` therefore behaves as `/cdn`, `https://cdn.example.com`
still adds nothing, and a prefix equal to the `basePath` prefix is still dropped (a
duplicate path pattern makes CloudFront reject the distribution). The sibling
`asset-prefix-absolute-no-path` fixture should pass for free: its path is `/`, which
normalizes to none, and its bundles are requested at plain `/_next/static/...`.

Two new test cases (`nextjs-distribution.test.ts` for the behavior and slice length,
`base-path.test.ts` for the two readers disagreeing on purpose), the existing "adds
no behavior for an assetPrefix that needs none" case extended with the two spellings
that still need none, README's `assetPrefix` section extended with the case, and
`OptionalNextjsDistributionProps` regenerated (`pnpm compile` then `pnpm projen`,
which left the `.mjs` bundles batch 12 is deploying from untouched). 22 suites / 413
tests green, `pnpm eslint` and `tsc --noEmit` clean.

Nothing is awaiting a verdict now. The requeue behind the next bundle is
`next-image-legacy/unicode` (18), `async-modules` (19), `i18n-support-catchall` (20),
`no-page-props` (21), `asset-prefix-absolute` (22), plus
`app-dir/not-found-with-pages-i18n`, `app-dir/app-basepath` and `app-dir/asset-prefix`
as regression checks, and `asset-prefix-absolute-no-path` as a new candidate the same
fix should have made green.

### Batch 12: 50 of 50 green, and batch 13 launched

Batch 12 (`/tmp/run-batch12.sh`, 50 new candidates, serial, `--retries 1`) finished
with `exiting with code 0` and no failing file — the first batch to come back
entirely green. It was deployed from the bundle that already carried defects 1–17
but *not* 18–22, so every one of its 50 files was a file those five defects never
touched: CSS Modules and Lightning CSS, cssnano, all six `global-not-found`
variants, the five `metadata-static-file` route shapes, MDX with and without
`mdx-components.tsx`, `modularizeImports`, Monaco, `next/dynamic`,
`metadata-thrown`, `.mjs` sources. All 50 are now in `rules.include`.

Manifest and screening regenerated (`node scripts/e2e-harness/screen.mjs --next
../next.js --write`): `included` 119 → 169, `candidates` 341 → 291. 212 files
screened, ~235 candidates never deployed, ~7 hours of wall clock left at the
95–140s per file the runs have settled at.

Then `pnpm bundle` (safe only now — batch 12 had exited; a batch in flight deploys
from `lib/**/*.mjs`) and batch 13 launched: the nine requeued/regression files the
previous entry listed, plus 41 unseen candidates, mostly the `next-config-ts`
matrix and `navigation-*`. Batch 13's first nine files are the verdict on defects
18 through 22 against a real deployment; until they come back green those five
defects stay listed as "queued" in `docs/harness-coverage.md`'s status table.

### Defect 23: one `revalidateTag` left a prerendered page uncacheable for good

The first defect this branch found from *our own* suite rather than from the harness.
`examples/e2e-tests/src/isr.test.ts` went red on every shard of PR #271's e2e run,
always on the same assertion: after `GET /api/revalidate?collection=collection` and a
reload, `x-nextjs-cache` has to be `STALE` or `HIT`, and it was `undefined`.

Reading the Playwright trace's `0-trace.network` gave the shape immediately. The
reload came back `cache-control: private, no-store` with `x-nextjs-postponed: 1` and
no `x-nextjs-cache` at all — not a stale hit, not a miss, but a *fallback shell*.
`/isr/1`'s `prerender-manifest.json` entry carries `fallback: "/isr/[id]"`, so its
build output is `compute: "resuming"`, and every subsequent request was answered by
resuming that shell dynamically. Re-running the file locally against a fresh deploy
reproduced it exactly once: green until the revalidate, permanently shell-served
after.

Two things had to be true at once for that, and defect 9's sibling change (`47354d2`,
`seedTagMappings`) supplied the second. `revalidateTag` wrote its bare-tag marker row
*and* deleted every S3 object the tag's mapping rows pointed at, and since that
commit those mapping rows include build-time prerenders. So the tag revalidation
destroyed `/isr/1`'s seeded entry outright. `get` then returned `null`, and a hard
miss on a route with a fallback is not a blocking render — Next.js answers from the
shell, and with `partialPrefetching` off nothing ever rewrites the concrete entry. One
`revalidateTag` therefore took the page out of the cache for the rest of the
deployment's life.

Next.js has a channel for exactly this and we were not using it. `lastModified: -1`
makes `IncrementalCache.get` report `isStale: -1`, which `app-page-runtime` reads as
an on-demand revalidation and answers with a blocking render of *this* route, storing
the result. Three changes, all in the cache layer:

- `S3CacheHandler.get`: a tag-expired **response** entry now returns
  `{ lastModified: -1, value }` and leaves the object in place. The re-render it
  provokes overwrites it through `set` with a `lastModified` past the marker, so
  nothing needs to delete it — and a render that throws is answered from the last
  good copy rather than from a shell. A **fetch** entry still deletes and returns
  `null`, because there a miss is the point: the request must refetch rather than
  reuse the body, which is what Next.js's own `FileSystemCache` does with
  `revalidatedTags`.
- `S3CacheHandler.revalidateTag`: no longer deletes the tag's S3 objects. The marker
  row is the invalidation; `get` compares it against each entry's own `lastModified`.
  The mapping rows are still read, because the CloudFront invalidation paths come
  from them.
- `CdkNextjsCacheHandler.get`: does not copy an expired (`lastModified: -1`) S3 entry
  into the memory layer. `MemoryCacheHandler.set` stamps `lastModified: Date.now()`,
  which would present the expired body as fresh and hide the revalidation from
  Next.js until the memory entry's TTL ran out — a second, subtler version of the
  same bug.

Covered by five new cases: `s3-cache-handler.test.ts` gains a response-entry
expiry, a fetch-entry miss, and a `revalidateTag` that asserts no
`DeleteObjectCommand`, and the existing seeded-prerender case now expects
`{ lastModified: -1, value }`; `cache-handler.test.ts` gains the two halves of the
memory-layer guard. 22 suites / 417 tests green, `pnpm eslint` and `tsc --noEmit`
clean.

This also sharpens the `resume-data-cache` note in `docs/harness-coverage.md`, which
said `null` and `lastModified: -1` both force a blocking render. They do for a route
with no fallback; for one with a fallback shell only `lastModified: -1` does.

### Batch 13: defects 19–22 verified, and defect 24 found inside defect 18's file

Batch 13 (50 files: the nine requeued/regression files behind defects 18–22, plus
41 new candidates) came back 49 green, 1 failing.

Four defects are now verified against a real deployment, not just offline:
`async-modules` (19), `i18n-support-catchall` (20), `no-page-props` (21) and
`asset-prefix-absolute` (22) all passed on attempt 0, and so did the three
regression checks (`app-dir/app-basepath`, `app-dir/asset-prefix`,
`app-dir/not-found-with-pages-i18n`) plus `asset-prefix-absolute-no-path`, which the
defect-22 fix was expected to make green for free and did. The remaining 41 were the
`next-config-ts` / `next-config-ts-native-mts` matrix (38 files), `next-config`,
`navigation-layout-suspense` and `navigation-with-queued-actions` — all green,
96–99s each.

`next-image-legacy/unicode` was the one failure, and it is defect 18 half-landing
rather than a regression. That fix made the app deployable (it had never built:
`public/hello world.jpg` cannot be spelled as a CloudFront path pattern), and 4 of
its 5 cases went green with it, both unicode ones included. The fifth kept 400ing:

```
/_next/image?url=%2Fhello%2520world.jpg&w=640&q=75  →  400
```

**Defect 24.** The `url` query value is double-encoded, so decoding the query string
leaves one layer and `validateParams` hands `fetchFromS3` the href
`/hello%20world.jpg` — while the object's key is `hello world.jpg`. `fetchFromS3`
used the href as the key verbatim, missed, and `resolveErrorResponse` mapped
`NoSuchKey` to the 400 that a genuinely missing local image is *supposed* to get,
which is why the symptom looked like an absent file rather than a key mismatch. The
unicode sibling passed all along because `äöüščří` is not percent-encoded inside the
`url` value: the query decode leaves the raw characters, which are already the
object's name. Next.js's own `fetchInternalImage` never hits this — it makes an HTTP
subrequest and lets its static file server resolve the path, which decodes on the
way.

Fix: `fetchFromS3` percent-decodes the asset path before joining the key prefix,
tolerantly — a path that isn't valid percent-encoding is used as given, because
that's what a literal `%` in a filename looks like (`public/100%.png` is requested
as `/100%.png`; browsers don't escape it and `decodeURIComponent` throws `URIError`
on it). The `basePath` strip still runs *before* the decode, since both sides of
that comparison are URL-space values, and `getFileNameWithExtension` deliberately
stays undecoded because Next.js's own `Content-Disposition` filename is undecoded
too. Four `image-utils.test.ts` cases: the space, both unicode spellings, the
literal `%`. `image-utils.ts` is at 100% coverage.

Manifest: 45 files added (four of the nine requeued were already in), `included`
169 → 214, `candidates` 291 → 246, ~190 never deployed, ~6 hours left. The
`next-config-ts` matrix is the first thing in `rules.include` that
`docs/harness-coverage.md` records as two collapsed rows rather than one row per
file — 38 near-identical fixtures whose individual names say nothing the family
name doesn't, with the reason for collapsing stated in the doc.

Then `pnpm bundle` and batch 14: `next-image-legacy/unicode` requeued for defect 24,
plus 49 new candidates.

### Batch 14, part 1: an 18-file family excluded, and a screen so it stays excluded

Batch 14's first nineteen files produced one pass and eighteen failures, and all
eighteen were the same family: `test/e2e/app-dir/next-config-ts-native-ts/**`.
Every one failed during `next build`, not at request time, with
`ERR_REQUIRE_ASYNC_MODULE` or `ReferenceError: await is not defined`.

That shape is ambiguous on its face — the harness builds through the adapter, so a
build failure could be ours. It isn't. Next.js loads a TypeScript `next.config.ts`
by swc-transpiling it to CJS and `require()`ing the result, which cannot express
top-level `await`; the alternative is Node's native TypeScript loader, gated on
`process.env.__NEXT_NODE_NATIVE_TS_LOADER_ENABLED === 'true'`, which only
`next build --experimental-next-config-strip-types` sets. Every fixture in this
family deliberately uses top-level `await`, because the native loader is the thing
under test.

Proved by building a copy of one fixture in `/tmp/ntscheck` with no adapter
involved: plain `next build` fails identically, and the same build with
`--experimental-next-config-strip-types` succeeds. (First attempt at the flagged
build died on "Failed to install required TypeScript dependencies"; it needs
`pnpm add -D typescript @types/react @types/node` first.)

Judgment call, recorded per working rule 6: **excluded as "no signal", not fixed.**
The flag could be added to `scripts/e2e-deploy.sh`, but it applies to the whole run
and would switch the 21 already-green `app-dir/next-config-ts/*` files off the
swc-transpile path they exist to cover. Trading measured coverage of the default
config loader for coverage of the opt-in one is a worse deal than leaving eighteen
files out with a written reason. `next-config-ts-native-mts/**` needs no flag — a
`.mts` config is ESM either way — and its 17 files stay green and included.

The real lesson was upstream of that. A file with a verdict in `excluded-notes` was
still being counted a candidate by `screen.mjs`, so these eighteen would have been
picked for a *second* batch and burned the slots again; I had been keeping decided
files out with a `/tmp/unseen.txt` that no compacted session would inherit.
`screen.mjs` now has a **verdict** screen that reads the manifest's own
`excluded-notes`, treating the keys that start with `test/e2e/` as predicates (`**`
honored as a directory-tree suffix, which is every shape the keys actually use) and
ignoring the prose keys like `"edge runtime, generally"`. The manifest is now the
record, which is where it belonged.

Effect: `verdict: 26` in `disqualified-by`, and candidates 246 → 227. Screened
258 → 276, `no signal` 28 → 46. Also documented in the harness README as a sixth
screen and in `docs/harness-coverage.md` under a new "No signal — the fixture
cannot be built here".

Batch 14 keeps running; `next-image-legacy/unicode` sorts late and is still the
outstanding deployed verdict on defect 24.

### Batch 14, part 2: 32 green, and defect 24 verified

Batch 14 finished 32 green / 18 failed, and the 18 are exactly the excluded
`next-config-ts-native-ts` family above — no other file failed. Its non-zero exit
means nothing beyond that.

`next-image-legacy/unicode` passed all 5 cases on attempt 0 in 163s, which is the
deployed verdict on **defect 24** (percent-decoding a `public/` filename before
building the S3 key). Every one of the 23 harness defects is now verified green
against a real deployment, not just unit-tested.

The other 31 are a broad slice of parallel routes — 17 files covering catch-all
slots, slot specificity, route groups, per-slot CSS and layouts, `default.tsx`,
scroll ownership, `useSelectedLayoutSegment`, `generateStaticParams` inside a slot
— plus four PPR/partial-prefetching files, `next/script`, `next/dynamic` CSS,
`<Image>` events, and `next.config` header de-duplication. Listed individually
rather than collapsed: unlike the `next-config-ts` matrix these are different
features, not one fixture crossed with build variants.

`rules.include` 214 → 246, candidates 227 → 195. `pnpm bundle`, then batch 15
launched with the next 50 candidates — mostly the 29-file `app-dir/scss/*` matrix
and the `segment-cache/*` family.

### Batch 15: 48 of 50 green, and a verdict that was not durable

48 green on attempt 0, 0 flakes, 2 red — and both red files already had a written
verdict. The 48: the whole 27-file `app-dir/scss/*` matrix (global vs. module Sass,
`composes`, `node_modules` `@import` in three spellings, `url()`, `additionalData`/
`prependData`/`includePaths`, multi-page and dynamic-route entries), five `proxy-*`
files, `next/script`'s `beforeInteractive` in both the ordinary and the XSS-probe
shape, `removeConsole`, `require.context`, `resolveExtensions`, root-layout
`redirect()`, and a handful of router/prefetch regression fixtures.

The `scss` rows are collapsed in `docs/harness-coverage.md` into one line, which
makes three collapsed rows in that table. Judgment call: on our side those 27 files
test one thing 27 ways — an emitted stylesheet reaching the browser from S3 through
the distribution — so spelling them out would add 27 lines and no information. They
stay in `rules.include` because they are the project's only Sass coverage and they
cost ~95s each.

The two red files, `revalidate-dynamic` (2 of 2) and `revalidate-path-with-rewrites`
(1 of 2, the `static page` case), are the documented CDN-inherent invalidation-timing
case: the test calls a route handler that runs `revalidatePath`, then re-reads
through CloudFront inside `retry()`'s 3s default, and a `CreateInvalidation` does not
land that fast. `revalidate-dynamic` returned the *same* random value across both
cases and both attempts, which is what an edge hit looks like; the
`revalidate-path-with-rewrites` `dynamic page` case passed in 1.2s because there is
no prerender to invalidate.

Neither should have been deployed at all. The verdict existed — written months of
batches ago — but under an `excluded-notes` key spelled as prose,
`"revalidation behind the CDN, two files"`, and the **verdict** screen added earlier
today only matches keys that start with `test/e2e/`. So the screen worked and the key
did not, and two deploy slots (~200s) went to re-proving a known result. Fixed by
re-keying: `revalidate-dynamic` now has its own file-path `excluded-notes` entry, and
`revalidate-path-with-rewrites` moved into `suites` with the `static page` case named
in `failed`, which is strictly better than excluding it — its dynamic-page case now
runs every time. The general rule, now recorded in the coverage doc: **a verdict is
only as durable as the manifest key it is written under.**

Audited the rest of the pool for the same gap: no other candidate has a verdict
written anywhere in `docs/harness-coverage.md`. `segment-cache/cached-navigations-*`
and `vary-params/root-params-segment-prefetch` look like doc mentions but are
genuinely different test files in a directory whose main file is already included.

`rules.include` 246 → 294, `suites` 3 → 4, candidates 195 → 145 (~4.5 hours left).
Batch 16 launched with the next 50 — the `segment-cache/*` remainder, then the
`app-dir` tail and the start of the non-`app-dir` e2e directories.

### Batch 16, part 1: defect 25 — a worker that never started

Batch 16 (50 files) came back 47 green, 3 red. Two of the reds were the same defect
and it is ours: `worker-module-url` and `worker-relay-compiler`, both of which do
`new Worker(new URL('./worker.ts', import.meta.url))`, rendered their page but never
received the worker's message.

`patchFetchInClientJs` (`src/nextjs-build/nextjs-build.ts`) prepends
`src/nextjs-build/patch-fetch.js` to every client entrypoint chunk, and its turbopack
selector is `file.startsWith("turbopack-") && file.endsWith(".js")`. Turbopack emits
its **web-worker** bootstrap as `static/chunks/turbopack-worker-<hash>.js`, which that
matches — so the patch was landing in a worker, where its first statement
`const originalFetch = window.fetch;` threw `ReferenceError: window is not defined`
before the worker's own module ever ran. Silent: the error goes to the worker's error
event, which the fixtures do not listen for, so the only symptom was a timeout on
placeholder text.

Fix: `patch-fetch.js` is now written against `globalThis` and the bare `location`
global, so one file is correct on the main thread and in a worker — and a worker's own
same-origin POSTs now get signed, which they never were. `XMLHttpRequest` is patched
behind a `typeof` guard, since some worker scopes have none and `class extends
undefined` is a `TypeError`. The chunk selector was left alone on purpose: making the
worker chunk work beats excluding it, because a POST from a worker needs the
`x-amz-content-sha256` header just as much as one from the page.

`patch-fetch.test.ts` was restructured — an `installScope()` helper puts the stubs on
`globalThis` (setting `window = global` for the main-thread tests, which is true in a
browser), plus a new `patch-fetch in a worker scope` block that requires the module
with neither `window` nor `XMLHttpRequest` present. 16 tests pass. Both e2e files then
went green against a real deployment on attempt 0 (103.0s, 97.0s).

Coverage doc gets `### 25`; the fixed-defect count goes 23 → 24.

### Batch 16, part 2: two defects behind one fixture, and 50 of 50 green

`segment-cache/memory-pressure` was batch 16's third red, and it turned out to be
hiding the two worst bugs the harness has found so far. The fixture is deliberately
extreme — 60 static params, each page rendering `{'a'.repeat(1024 * 1024)}` — and
being extreme is exactly why it caught them.

**Defect 26: a large init cache was only partly seeded, silently.** The segment
prefetch for `/memory-pressure/0` answered 572 bytes of postponed shell where the
build had written a complete 1,049,321-byte segment, with `x-nextjs-cache: MISS`.
The cache bucket held 14 objects against the seed directory's 64, and the
`BucketDeployment` Lambda's log said `[Errno 28] No space left on device` in
`zip.extractall` — CDK gives that Lambda 512 MiB of `/tmp` and this app's seed
directory is 664 MiB. It *did* report `Status: FAILED`, to
`required-to-be-present-by-cfn`, because `cdk deploy --hotswap` invokes custom
resources with placeholder response URLs and never reads the answer; the CLI printed
"Contents of AWS::S3::Bucket … hotswapped!" and exited 0. `NextjsCache` now sizes
that Lambda from the seed directory: ephemeral storage of twice the directory plus
headroom, floored at 512 MiB and capped at Lambda's 10 GiB, `memoryLimit: 1024` past
256 MiB, a warning above the ceiling pointing at `useEfs: true`, and
`overrides.bucketDeploymentProps` still winning. Four `nextjs-cache.test.ts` cases
(the large one uses a sparse file so the test stays fast).

**Defect 27: every cached byte was a JSON integer.** With the cache seeded, the
LRU case still timed out at 60s — next.js's hard per-case limit for non-dev modes —
and the reason was that one 1 MiB segment prefetch took **4.8s of Lambda time**,
against 45ms for a small segment from the same cache and the same regardless of
`Accept-Encoding`. The entry on S3 was 11.6 MiB for ~1 MiB of payload, because
`serializeCacheValue` wrote Buffers as arrays of per-byte integers — and
`parseCacheValue` reads with a `JSON.parse` reviver, which the engine calls once per
array element. One page of this fixture carries the payload three times
(`rscData`, `_full`, `__PAGE__`), so answering one prefetch meant visiting over
three million JSON numbers. Buffers now serialize as base64; both integer-array
spellings are still read back, so older entries stay readable. Measured on the same
deployment: entry 11,592,130 → 6,319,731 bytes, Lambda 4,800ms → 113–146ms,
response ~5.0s → ~0.2s. **This is a ~40x win on the hot path for any app with a
large RSC payload**, not just this fixture, and it is the first defect the harness
has produced that is a performance bug rather than a correctness one.

With both fixed the file passes on attempt 0 in 180.33s, and so do the two worker
files from defect 25 — so all 50 of batch 16 are green and promoted.

`rules.include` 294 → 344, candidates 145 → 95 (~3 hours of wall clock left), fixed
harness defects 24 → 26. Batch 17 next, from the remaining 95.
