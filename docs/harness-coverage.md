# Next.js compatibility harness — coverage record

What has been run from [vercel/next.js's own e2e suite][harness] against a real
cdk-nextjs deployment, what happened, and — for anything that failed — why, plus
an explicit verdict on whether the failure is acceptable or a bug to fix.

`test/deploy-tests-manifest.json` is the machine-readable half: its
`rules.include` is what the harness actually runs, and nothing goes in there that
has not been watched to pass. This file is the human-readable half. See
`scripts/e2e-harness/README.md` for how the harness works and how to screen a
new candidate.

## Verdict key

| Verdict          | Meaning                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| **pass**         | Runs and passes against a real deployment. Listed in `rules.include`.             |
| **fixed**        | Failed, was root-caused to a cdk-nextjs defect, and the defect has been fixed.   |
| **bug**          | Fails for a cdk-nextjs reason. Not acceptable. Fix it, then add the file.         |
| **unsupported**  | Fails because of a deliberate, documented product limitation. Acceptable.        |
| **CDN-inherent** | Fails for a reason true of any CDN-fronted deployment, not just this one. Acceptable. |
| **no signal**    | next.js skips or gates the file itself. Nothing was measured either way.          |

"Acceptable" means the failure is understood and is not worth fixing — it is not
a reason to stop widening the list elsewhere. Every **bug** row is a defect that
should come back as a regression test once fixed.

## Status

As of 2026-09-22, screening 1134 e2e files down to 26 candidates and deploying
22 of them:

| Verdict          | Files  |
| ---------------- | ------ |
| pass             | 21     |
| fixed            | 4 defects, which between them had been failing cases in 6 files |
| bug              | 0      |
| CDN-inherent     | 2      |
| no signal        | 2      |
| unsupported      | ~613 (~612 edge, plus `prerender-encoding`; the edge ones are not individually enumerated) |

The four fixed defects are the harness's whole return on investment so far. All
four were real, all four shipped, and none of them could have been caught by the
construct tests or by `examples/e2e-tests`.

## Passing — in `rules.include`

All cases in each file pass, on the first attempt, against a shared
`NextjsGlobalFunctions` deployment.

| File                                                            | What it covers                                    |
| --------------------------------------------------------------- | ------------------------------------------------- |
| `app-dir/actions-streaming`                                     | A server action returning a `ReadableStream`      |
| `app-dir/app-basepath`                                          | A `basePath` deployment, incl. action `redirect()` — 13 cases |
| `app-dir/dynamic-interception-route-revalidate`                  | An action calling `revalidatePath`, on an interception route |
| `app-dir/headers-static-bailout`                                | `headers()` forcing a static route dynamic        |
| `app-dir/metadata-streaming`                                    | Streamed `<head>` metadata                        |
| `app-dir/prefetching-not-found`                                 | Prefetch of a `not-found` route                   |
| `app-dir/redirect-rewrite-dynamic`                              | `next.config` redirects/rewrites on dynamic routes |
| `app-dir/searchparams-static-bailout`                           | `searchParams` forcing a static route dynamic     |
| `app-dir/segment-cache/basic`                                   | Segment-level prefetch cache, core behavior       |
| `app-dir/segment-cache/cached-navigations`                       | Prefetch off the inlined app shell — 14 cases     |
| `app-dir/segment-cache/client-params`                           | Client-read params in cached segments             |
| `app-dir/segment-cache/deployment-skew`                         | `x-deployment-id` on HTML and RSC responses       |
| `app-dir/segment-cache/encoded-slash-params`                    | `%2F` inside a dynamic param                      |
| `app-dir/segment-cache/headers-keyed-caches`                    | Cache keyed on request headers                    |
| `app-dir/segment-cache/metadata`                                | Metadata in prefetched segments                   |
| `app-dir/segment-cache/no-prefetch`                             | `prefetch={false}`                                |
| `app-dir/segment-cache/prefetch-auto`                           | Default (`auto`) prefetching                      |
| `app-dir/segment-cache/prefetch-static-shell`                   | Static-shell prefetch                             |
| `app-dir/segment-cache/staleness/segment-cache-stale-time`      | `staleTime` expiry                                |
| `app-dir/segment-cache/vary-params`                             | Cache variance across params                      |
| `app-dir/static-rsc-cache-components`                           | `cacheComponents` prerender served without a dynamic render |

`encoded-slash-params` passing is worth noting next to the `prerender-encoding`
row below: `%2F` in a param works, which is part of why that file turned out not
to be an encoding bug at all.

## Fixed — real bugs, found by the harness

### 1. Every POST with a body was rejected at the edge — `403 InvalidSignatureException`

**Files:** `app-dir/actions-streaming`,
`app-dir/dynamic-interception-route-revalidate`, `app-dir/app-basepath`.
**Verdict: fixed.** All three are now in `rules.include`.

Every case that drove a server action and then expected the client to act on the
response failed; everything else in the same files passed. The server function's
own logs were clean — ~60–80ms per invocation, no error — which read at first as
"the reply is being made and something eats it on the way back".

The Playwright traces (`test/traces/`, written because `run-tests.js` sets
`TRACE_PLAYWRIGHT=true`) said otherwise. Every action POST came back:

```
POST /base/client  →  403
x-amzn-errortype: InvalidSignatureException
{"message":"The request signature we calculated does not match the signature you provided. …"}
```

Reproduced by hand against a deployment, and the boundary is exactly the body:

```
POST, 2-byte body                  → 403 InvalidSignatureException
POST, no body                      → 200
POST, 2-byte body + correct
  x-amz-content-sha256 header      → 200
```

That is [documented AWS behavior][oac]: *"If you use PUT or POST methods with
your Lambda function URL, your users must compute the SHA256 of the body and
include the payload hash value of the request body in the
`x-amz-content-sha256` header when sending the request to CloudFront. Lambda
doesn't support unsigned payloads."* CloudFront's origin access control signs the
origin request with SigV4 and supplies the empty-body hash for a GET, but it will
not hash a body — so the viewer has to, and a browser has no way to do that on
its own.

cdk-nextjs already solves this. `src/nextjs-build/patch-fetch.js` wraps
`fetch`/`XMLHttpRequest` to compute the hash, and
`NextjsBuild#patchFetchInClientJs` prepends it to the client entrypoint chunks —
for `NextjsGlobalFunctions` only, because it is the only type fronted by a signed
Function URL.

The bug was **where that call lived**: inside `runNextBuild()`, so
`skipBuild: true` skipped it along with the build. The harness sets
`skipBuild: true` (it has to — `scripts/e2e-deploy.sh` runs `next build` itself,
to emit the markers the harness parses), so every harness deployment shipped an
unpatched client. So did every user's, with the same prop.

Fix: the call moved out of `runNextBuild()` into the constructor, after the build
gate, still guarded on `NextjsType.GLOBAL_FUNCTIONS`. Since the same `.next` can
now be synthesized more than once, the prepend is guarded by a marker comment so
it cannot double-wrap.

Two things this says about the test setup, beyond the fix:

- `examples/e2e-tests` covers server actions and is green on
  `NextjsGlobalFunctions`, but only ever on the `skipBuild: false` path. It could
  not have caught this.
- The harness is the regression test for it. There is no `NextjsBuild` construct
  test to add this to — one would need a whole synthetic `.next` (adapter
  manifest, `BUILD_ID`, client chunks) — and the harness exercises exactly the
  `skipBuild: true` path that broke.

### 2. Seeded prerender headers mislabeled every RSC response as HTML

**Files:** `app-dir/app-basepath` (the 3 action-`redirect()` cases),
`app-dir/segment-cache/deployment-skew`,
`app-dir/static-rsc-cache-components`. **Verdict: fixed**
(`appPageCacheHeaders` in `src/adapter/cache-utils.ts`). All three now pass.

`onBuildComplete` seeded the HTML prerender's `fallback.initialHeaders` verbatim
into the `APP_PAGE` cache entry — including `content-type: text/html;
charset=utf-8`. That is a category error: `initialHeaders` describes how a
platform should serve the prerendered *file* off a CDN, whereas a cache entry is
served by `app-page-runtime.js`, which `appendHeader`s `cachedData.headers` onto
the response and *only then* picks the HTML or the flight variant the request
actually asked for. And `send-payload.js` will not correct it:

```js
if (!res.getHeader('Content-Type') && result.contentType) {
  res.setHeader('Content-Type', result.contentType)
}
```

So every RSC request to every prerendered page answered the flight payload
labeled `text/html`, with a doubled `vary` and `x-nextjs-prerender` for good
measure. Three unrelated-looking failures were all this:

- `deployment-skew`'s `header is set on RSC responses` asserted
  `content-type: text/x-component` and got `text/html; charset=utf-8`.
- `static-rsc-cache-components` measured a navigation duration of `NaN` — the
  navigation never completed, because the client router rejects a flight payload
  that arrives as HTML.
- `app-basepath`'s action `redirect()` cases answered with *no head at all*.
  `createRedirectRenderResult` (`packages/next/src/server/app-render/
  action-handler.ts`) streams an app-relative redirect by fetching the target
  back through the deployment's own origin and gating on
  `response.headers.get('content-type')?.startsWith(RSC_CONTENT_TYPE_HEADER)`.
  Mismatch → `response.body?.cancel()` → `RenderResult.EMPTY` → a zero-byte
  streamed Lambda response, which is defect 3.

Fix: filter `content-type`, `vary`, `x-nextjs-prerender` and
`x-nextjs-postponed` out of `APP_PAGE` entries, keeping everything the render
would genuinely have stored (`x-nextjs-stale-time`, `x-next-cache-tags`, and
whatever the app set through `headers()`/`cookies()`). `APP_ROUTE` entries are
deliberately *not* filtered — a route handler's `content-type` is part of its
cached response, and `app-route.js` replays those headers verbatim. Regression
test: `src/adapter/cache-utils.test.ts`.

### 3. A zero-byte streamed response lost its entire head on a Function URL

**Files:** `app-dir/app-basepath` (same 3 cases, as the downstream half of
defect 2). **Verdict: fixed** (`ResponseSink.padEmptyBody`, set on
`LambdaResponseSink`).

Independent of *why* a response ends up empty, an empty one was unserveable. A
`RESPONSE_STREAM` Lambda writes an `awslambda.HttpResponseStream.from` prelude,
a `\0`×8 delimiter, then the body. With zero payload bytes after the delimiter:

| Integration    | Result                                               |
| -------------- | ---------------------------------------------------- |
| Function URL   | prelude discarded — bare `200 application/octet-stream`, stream not closed cleanly |
| API Gateway    | `502`                                                |

Writing a single space byte fixes both, and costs nothing that matters: a `304`
and a `HEAD` have no body by definition, and the integration overwrites
`content-length` itself. Verified by instrumenting the deployed function rather
than by deduction — three plausible guesses (a head event racing `pipeToSink`,
`useDefineForClassFields` breaking `res.flush`, the sub-fetch's
`content-encoding`) were all wrong, and the `[probe]` logs settled it in one
run. Regression tests: `src/runtime/http/sink.test.ts`.

### 4. The home page's cache entry had no flight payload — every navigation to `/` 404'd

**Files:** `app-dir/segment-cache/cached-navigations` (3 of 14 cases).
**Verdict: fixed** (`groupPrerenders` in `src/adapter/cache-utils.ts`).

Next.js emits up to three outputs per prerendered route — `/blog/hello`,
`/blog/hello.rsc`, `/blog/hello.segments/*.segment.rsc` — and `onBuildComplete`
has to group them by route before it can seed one cache entry. It did that by
stripping suffixes, then reconstructing `${route}.rsc` to find the payload.

The root route breaks that, because it cannot be named `/.rsc`. Next emits its
HTML at `/` but its payload at `/index.rsc` and its segments under
`/index.segments/` — and with a `basePath`, `/prod` versus `/prod/index.rsc`.
Measured over both fixture shapes:

```
no basePath:   "/"      html=yes rsc=no  segments=4
basePath /prod: "/prod"       html=yes rsc=no  segments=0
                "/prod/index" html=no  rsc=yes segments=4   ← skipped, no HTML
```

So the home page was seeded with `html` but `rscData: undefined`. `app-page-
runtime.js` handles that case by falling back to `cachedData.html.contentType`,
and under `cacheComponents` sends `res.statusCode = 404` with
`RenderResult.EMPTY` — which is exactly what the harness recorded:

```
GET /?_rsc=_aiG6yzaaivOHhuC
  → 404, content-type: application/json, x-nextjs-cache: HIT, empty body
```

Fix: group by parsing the emitted names rather than reconstructing them, and
remap a trailing `/index` onto its parent when — and only when — the parent is
itself a prerendered HTML route. The condition matters: an app with a real
`app/index/page.tsx` has a genuine `/index` route that must keep its own group.
Regression test: `src/adapter/cache-utils.test.ts`.

## Unsupported — a product limitation

### `dynamicParams = false`

`app-dir/prerender-encoding` (1 of 1 case). **Verdict: unsupported.** Not an
encoding bug, despite the file's name and the shape of the failure.

The fixture prerenders the param `sticks & stones` via `generateStaticParams`
and requests `/sticks%20%26%20stones`; cdk-nextjs returns the 404 page. Encoding
turned out to be fine — dispatching that path against the adapter manifest
resolves `nxtPid` to exactly `sticks & stones`. The trigger is one line in the
fixture: `export const dynamicParams = false`.

With that flag, Next.js emits the route's `routing.dynamicRoutes` entries gated
behind preview cookies, because the platform is expected to serve the concrete
prerendered paths off the CDN itself and 404 everything else:

```
has: [{type:'cookie', key:'__prerender_bypass', value:…},
      {type:'cookie', key:'__next_preview_data'}]
```

cdk-nextjs registers only dynamic *templates* in `manifest.pathnames`
(`addPrerenderTemplates` in `src/adapter/build-outputs.ts`), so nothing matches
the gate and every param 404s — `/plain` as much as the encoded one. Removing
the flag from a copy of the fixture makes both resolve:

```
dynamicParams = false   "/plain"                 → not-found
                        "/sticks%20%26%20stones" → not-found
flag removed            "/plain"                 → /[id]  nxtPid="plain"
                        "/sticks%20%26%20stones" → /[id]  nxtPid="sticks & stones"
```

Supporting it means routing concrete prerendered paths to the owning entrypoint
*while still supplying the template's `nxtP*` params* — which is precisely what
`addPrerenderTemplates`'s own comment records as measured-wrong when done
naively (`/isr/1` then resolves to itself rather than to `/isr/[id]`, losing the
`nxtPid` the route needs). A design change, not a patch, and worth doing only if
a user asks.

Incidentally measured while chasing this: an unencoded `&` in a path is parsed
as a query separator (`/a&b` → `{nxtPid: "a", b: ""}`), which matches Vercel.

## Unsupported — the edge runtime

cdk-nextjs refuses at build time to deploy any output whose runtime is not
`nodejs` (`assertNodeRuntimes` in `src/adapter/build-outputs.ts`). That is a
deliberate product limitation: the edge runtime is deprecated in Next.js, and
cdk-nextjs supports Next.js 16's Node-runtime `proxy.ts` instead of the legacy
edge-only `middleware.ts`.

The check throws during `next build`, so a fixture containing *any* edge route or
legacy middleware fails **wholesale** — per-case `failed` entries in the manifest
cannot rescue it, and the file has to stay out of `rules.include`. About 522 of
next.js's 1134 e2e files are edge-free, so this is not much of a constraint on
widening the list.

Not enumerated file by file. Three worth naming:

| File                                 | Why                                            |
| ------------------------------------ | ---------------------------------------------- |
| `app-dir/app-static`                 | ~10 `*-edge` routes declare `runtime = 'edge'`. Worth revisiting as a source of individual cases to port — it is the densest coverage of the ISR/caching behavior cdk-nextjs's cache handler implements. |
| `app-dir/actions/app-action`         | Fixture ships a legacy edge `middleware.js`.   |
| `middleware-rewrites/test/index`     | Fixture ships a legacy edge `middleware.js`.   |

## CDN-inherent — excluded, acceptable

### Revalidation re-requested about a second later

`app-dir/revalidate-dynamic` (2 of 2) and
`app-dir/revalidate-path-with-rewrites` (1 of 2).

Each loads a prerendered page, calls a route handler that runs
`revalidatePath`/`revalidateTag`, asserts the handler returned
`revalidated: true` (it does), refreshes immediately, and expects new content.
The refresh is served from the CloudFront edge: a prerendered app-router page
comes back `cache-control: s-maxage=31536000`, and the second request to it
reports `x-cache: Hit from cloudfront` (verified by hand).

cdk-nextjs does invalidate the edge on explicit revalidation
(`invalidateCloudFrontPaths` in `src/adapter/s3-cache-handler.ts`, and see
`docs/caching-guide.md`) but fire-and-forget: `CreateInvalidation` has no bounded
completion SLA and these tests re-request within about a second. Vercel purges
its own CDN as part of the revalidate, which is why the tests are not gated out
of deploy mode upstream.

Not a defect, and not worth chasing — making it pass would mean blocking every
revalidation on an invalidation that usually takes tens of seconds.

## No signal — next.js skips these itself

| File                                    | Why                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `app-dir/segment-cache/refresh`         | `describe.skip` upstream, commented `Disabled because too flaky`. Recorded so it is not re-screened: it reports "passing" in ~5s without deploying anything. |
| `app-dir/segment-cache/cdn-cache-busting` | next.js skips it under `isNextDeploy`. Listed as a worked example of deploy mode gating out what cannot work behind a CDN.           |

## Reading a harness log

One trap, because it has cost time twice. A file that fails **wholesale** at
around 120s, with `thrown: "Exceeded timeout of 120000 ms for a hook."` in
`beforeAll`, did not fail: the CloudFormation deploy outran jest's hook timeout.
That is what `--retries 1` is for. Read the retry, not attempt 0.

[harness]: https://nextjs.org/docs/app/api-reference/adapters/testing-adapters
[oac]: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html
