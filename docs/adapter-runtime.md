# The adapter runtime

How cdk-nextjs serves a Next.js app on all four deployment types: what runs at
build time, what runs per request, where it knowingly differs from `next start`,
and what each deployment type cannot do. The reasoning behind individual
decisions lives in the code comments next to them; this is the map.

Written against Next.js 16.3.5. `@next/routing` is exact-pinned to the `next`
version and bumped with it.

## Build time: `onBuildComplete`

`src/adapter/adapter.mts` is the Next.js [deployment adapter][adapters]. Its
`onBuildComplete` hook calls `buildAdapterManifest` in
`src/adapter/build-outputs.ts`, which produces two things inside
`<distDir>/cdk-nextjs-adapter/`:

- **The staging tree** (`app/`, or `groups/<name>/` with `functionGroups`): the
  union of every shipped output's traced `assets`, keyed by repo-root-relative
  path. It replaces `output: "standalone"`, which cdk-nextjs no longer sets. This
  directory is the _deployment root_: the Lambda zip and the container image's
  `WORKDIR`.
- **`manifest.json`** (`src/runtime/manifest.ts`): the only contract between
  build, synth and runtime. It holds `ctx.routing` verbatim, the entrypoint for
  every route template, the build's static files, middleware, and the config
  fields the runtime needs. Every path in it is a repo-root-relative POSIX key,
  never an absolute path.

The same hook seeds the init cache for the S3 + DynamoDB cache handler, and it
refuses any output whose runtime is not `nodejs` (`assertNodeRuntimes`).

What is deliberately _not_ in the staging tree: `<distDir>/static` and
`public/`. On the Lambda types, CloudFront or API Gateway answers them from S3,
and `public/` alone can exceed the 250 MB unzipped Lambda limit. The container
images copy both in (`src/nextjs-build/*.Dockerfile`).

## Request time

```
shell  ──►  NextjsRuntime.handle  ──►  Dispatcher.dispatch  ──►  one of:
lambda.mts   (src/runtime/core.ts)      (dispatch.ts)             entrypoint
server.mts                               @next/routing             static file
                                         resolveRoutes             /_next/image
                                         + middleware runner       redirect / external rewrite
                                                                   middleware's own response
                                                                   404 / 500 ladder
```

- **Shells.** `lambda.mts` (Lambda response streaming; Function URL events on
  `NextjsGlobalFunctions`, API Gateway REST streaming events on
  `NextjsRegionalFunctions`) and `server.mts` (`node:http`, both Containers
  types). Each only translates its input into a `RuntimeRequest` and its output
  into a `ResponseSink`. Both run the same core, so the container e2e suite
  exercises the code Lambda runs.
- **Core** (`core.ts`). It synthesizes `IncomingMessage`/`ServerResponse` shims
  (`http/`), dispatches, and acts on the result. It gzips streamed responses
  itself, because neither API Gateway in STREAM mode nor CloudFront compresses a
  response without `Content-Length`. It awaits `waitUntil` work before
  returning, since Lambda freezes on return.
- **Dispatch** (`dispatch.ts`). Route matching is `@next/routing`'s
  `resolveRoutes`, the library `next start`'s router was refactored to expose.
  Dispatch adds what it gets wrong or leaves out, each with a comment:
  `trailingSlash` variants, the i18n root, `nxtP` param repair, redirect-location
  normalization. The routing table (pathnames plus every spelling of every
  static file) is built once per cold start and cached.
- **Middleware** (`middleware.ts`) runs through `resolveRoutes`'s
  `invokeMiddleware` callback. Request bodies are teed so middleware and the
  entrypoint both read them.
- **Entrypoints** (`entrypoints.ts`) are required lazily, on first use, which is
  most of the cold-start win over `server.js`.
- **Static files** (`static-files.ts`) go through Next.js's own `serveStatic`
  (`send`), called as `next start` calls it. `public/` is listed off disk at
  cold start (`public-files.ts`) rather than from the manifest, so files a
  `postbuild` writes are included. On the Lambda types the directory is absent
  and dispatch knows no `public/` files.
- **Image optimization** (`image.ts`) runs inside the runtime, after middleware.
  On the Lambda types it reads source images from the static-assets bucket. There
  is no separate image Lambda any more, because middleware never ran for it.
- **Cache** (`src/adapter/cache-handler.ts`): memory in front of S3 + DynamoDB
  at runtime, local files at build time. It also creates the CloudFront
  invalidations for on-demand revalidation on the Global types.

### Invariants worth not breaking

- **`process.cwd()` is the staged project dir.** Next.js inlines
  `relative(buildCwd, projectDir)` into every entrypoint and resolves it against
  the runtime cwd. `loadRuntime` chdirs and asserts this. `build-outputs.ts`
  asserts the build ran from the project dir, so the inlined value is `""`.
- **`minimalMode` is never set.** The non-minimal path keeps the incremental
  cache inside the entrypoint, which the cache handler depends on.
- **PPR is origin-only**, as in `next start`. The CDN-shell variant needs
  CloudFront to splice an edge response with an origin stream, which it cannot
  do.
- **The dispatcher is per request**, because middleware's `Response` comes back
  through a closure. Anything expensive belongs in the cached routing table, not
  in the constructor.

## Where it differs from `next start`, knowingly

| Behavior                                                   | `next start`                           | cdk-nextjs                | Why                                                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Edge runtime, legacy edge `middleware.ts`                  | supported                              | build fails               | Deprecated upstream. Node-runtime `proxy.ts` is supported.                                                                                 |
| `dynamicParams = false`                                    | concrete prerenders served, others 404 | every param 404s          | Next.js gates the route behind preview cookies and expects the platform to serve prerenders off the CDN. Supporting it is a design change. |
| Rewrite destination with a repeated query key (`?a=1&a=2`) | array                                  | last value only           | `@next/routing` bug ([vercel/next.js#99155](https://github.com/vercel/next.js/issues/99155)).                                              |
| Static file requested with POST/PUT/DELETE                 | 405 rendered through `/_error`         | 405, plain text           | Same status and `Allow`; not worth an error-page render.                                                                                   |
| Response compression                                       | gzip or brotli                         | gzip only, in the runtime | Brotli's streaming throughput is poor at default quality.                                                                                  |
| `public/` under a locale prefix                            | default locales only                   | default locales only      | Same. Listed because it surprises people: `/fr/x.txt` 404s unless `fr` is a domain's default.                                              |
| Missing `/_next/static/*` on the Global types              | 404                                    | 403 from S3               | OAC grants `GetObject`, not `ListBucket`, so S3 can't say the key is absent.                                                               |
| `resume-data-cache` cases                                  | pass                                   | 2 cases fail              | A multi-instance cache can't give the per-process guarantee the fixture asserts.                                                           |
| `config.maxDuration`, `preferredRegion`                    | honored on Vercel                      | dropped, with a warning   | A Lambda timeout is per function, not per route; region is a stack-level choice.                                                           |

The compatibility harness keeps the full record, with a verdict per excluded
case: [`harness-coverage.md`](./harness-coverage.md).

## Per-type limitations

|                                                                                | Global Functions                                              | Global Containers             | Regional Functions                                              | Regional Containers    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------- | ---------------------- |
| Front door                                                                     | CloudFront → Function URL (IAM, SigV4)                        | CloudFront → ALB (VPC origin) | API Gateway REST → Lambda                                       | ALB                    |
| Static assets                                                                  | S3 via CloudFront                                             | S3 via CloudFront             | S3 via API Gateway                                              | from disk in the image |
| 25-behavior budget: top-level `public/` entries plus `functionGroups` patterns | yes                                                           | yes                           | no                                                              | no                     |
| Client `Authorization` header                                                  | used by SigV4; send credentials under another name            | passes                        | passes                                                          | passes                 |
| POST/PUT body from a non-browser client                                        | needs `x-amz-content-sha256`                                  | fine                          | fine                                                            | fine                   |
| HEAD `content-length`                                                          | always `0` (Function URL)                                     | declared                      | declared                                                        | declared               |
| `public/` names                                                                | no CloudFront-spellable character → no behavior, warning, 404 | same                          | outside `[a-zA-Z0-9:._-$]` at top level → skipped, warning, 404 | any name               |
| `functionGroups`                                                               | yes                                                           | no                            | yes                                                             | no                     |
| Stage prefix                                                                   | —                                                             | —                             | put back for a `basePath` that starts with it                   | —                      |

Each of these is in the README's Limitations too, or in `breaking-changes.md`
for anything that changed from an earlier release.

## Debugging

- **Compare with `next start` on the same build.** `scripts/e2e-offline.sh
<next.js fixture>` builds one fixture through the adapter and serves it twice,
  through our container shell and through `next start`. Most "why does the
  deployment disagree" questions come down to diffing the two responses. For an
  app in `examples/`, run `lib/runtime/server.mjs` from its
  `.next/cdk-nextjs-adapter/app`, with `.next/static` and `public` copied in as
  the Dockerfile does.
- **Tell the CDN from the origin.** Behind CloudFront, `x-cache` says whether the
  edge answered, and every other header is the one the _cached copy_ was stored
  with. An `x-nextjs-cache: REVALIDATED` on a `Hit from cloudfront` is an old
  origin response, not a fresh render. The dynamic cache policy caches only what
  sends `Cache-Control` (`s-maxage`); everything else goes to the origin.
- **Dispatch without AWS.** `src/runtime/dispatch.test.ts` runs the real
  Dispatcher against manifests built from captured `onBuildComplete` contexts.
  Add a case there before you deploy. Refresh the captures with
  `scripts/capture-adapter-fixture.mjs` after a `next` upgrade.
- **Logs.** Unhandled errors are logged by the core before the error page is
  rendered. The cache handler logs under `DEBUG=cdk-nextjs:*`.

[adapters]: https://nextjs.org/docs/app/api-reference/adapters
