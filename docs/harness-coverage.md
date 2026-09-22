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
| pass             | 17     |
| fixed            | 1 defect, which had been failing cases in 3 files |
| bug              | 5      |
| CDN-inherent     | 2      |
| no signal        | 2      |
| unsupported      | ~612 (not individually enumerated; see "Edge runtime" below) |

## Passing — in `rules.include`

All cases in each file pass, on the first attempt, against a shared
`NextjsGlobalFunctions` deployment.

| File                                                            | What it covers                                    |
| --------------------------------------------------------------- | ------------------------------------------------- |
| `app-dir/actions-streaming`                                     | A server action returning a `ReadableStream`      |
| `app-dir/dynamic-interception-route-revalidate`                  | An action calling `revalidatePath`, on an interception route |
| `app-dir/headers-static-bailout`                                | `headers()` forcing a static route dynamic        |
| `app-dir/metadata-streaming`                                    | Streamed `<head>` metadata                        |
| `app-dir/prefetching-not-found`                                 | Prefetch of a `not-found` route                   |
| `app-dir/redirect-rewrite-dynamic`                              | `next.config` redirects/rewrites on dynamic routes |
| `app-dir/searchparams-static-bailout`                           | `searchParams` forcing a static route dynamic     |
| `app-dir/segment-cache/basic`                                   | Segment-level prefetch cache, core behavior       |
| `app-dir/segment-cache/client-params`                           | Client-read params in cached segments             |
| `app-dir/segment-cache/encoded-slash-params`                    | `%2F` inside a dynamic param                      |
| `app-dir/segment-cache/headers-keyed-caches`                    | Cache keyed on request headers                    |
| `app-dir/segment-cache/metadata`                                | Metadata in prefetched segments                   |
| `app-dir/segment-cache/no-prefetch`                             | `prefetch={false}`                                |
| `app-dir/segment-cache/prefetch-auto`                           | Default (`auto`) prefetching                      |
| `app-dir/segment-cache/prefetch-static-shell`                   | Static-shell prefetch                             |
| `app-dir/segment-cache/staleness/segment-cache-stale-time`      | `staleTime` expiry                                |
| `app-dir/segment-cache/vary-params`                             | Cache variance across params                      |

`encoded-slash-params` passing is worth noting next to the `prerender-encoding`
bug below: `%2F` in a param works, so that bug is narrower than "encoded params".

## Fixed — a real bug, found by the harness

### Every POST with a body was rejected at the edge — `403 InvalidSignatureException`

**Files:** `app-dir/actions-streaming`,
`app-dir/dynamic-interception-route-revalidate`, `app-dir/app-basepath` (3 of
13 cases). **Verdict: fixed.** The first two now pass and are in
`rules.include`; `app-basepath` gets past the 403 and then hits a second,
unrelated defect — see the bug section below.

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

## Bugs — excluded, pending fix

These fail for cdk-nextjs's own reasons. Each should become a regression test.

### `app-dir/app-basepath` — an action `redirect()` answers with no head at all

3 of 13 cases: `should properly stream an internal server action redirect() with
a relative URL`, `… with a absolute URL`, and `should redirect externally when
encountering absolute URLs on the same host outside the basePath`. Each asserts
the browser navigates; it never leaves `/base/client`. Failed all three attempts.

This is what was left after the `x-amz-content-sha256` fix above. The POST now
carries the header and reaches the origin — but the browser records no response
(Playwright: `status -1`, empty response, all timings `-1`). By hand:

```
POST /base/client  (next-action header, 12-byte body, correct x-amz-content-sha256)
→ HTTP/2 200
  content-type: application/octet-stream
  x-content-type-options: nosniff
  (empty body)
  curl: (92) HTTP/2 stream 1 was not closed cleanly: INTERNAL_ERROR
```

`application/octet-stream`, none of Next.js's headers, and an aborted stream is
the signature of a Function URL `RESPONSE_STREAM` invocation where the
`awslambda.HttpResponseStream.from` prelude was never written — so the head
`ShimServerResponse` emits never reached `LambdaResponseSink.begin`
(`src/runtime/lambda.mts`), or the invocation ended before it could. The function
completes in ~22ms and logs nothing.

Two things narrow it but do not explain it:

- It is not universal to action POSTs. `actions-streaming` and
  `dynamic-interception-route-revalidate` both drive actions and both pass. A
  probe with a stale `next-action` id against a prerendered path returned a
  correct `404 text/plain` with `x-nextjs-action-not-found: 1`.
- All three failing cases are the `redirect()`-from-an-action path, which in
  Next.js is not an ordinary response: `createRedirectRenderResult`
  (`packages/next/src/server/app-render/action-handler.ts`) sets
  `x-action-redirect` and then, for an app-relative target, **fetches the
  destination back through the deployment's own origin** (`initURL`'s origin,
  which for us is the CloudFront URL) to stream the next page in the same
  roundtrip. That sub-request inherits the original POST's forwarded headers,
  `x-amz-content-sha256` among them, on a GET with no body — which the origin
  access control would then be signing against the wrong payload hash. The third
  case takes no sub-fetch at all (the target is outside the `basePath`) and still
  fails, so the sub-fetch cannot be the whole story.

### `app-dir/prerender-encoding` — prerendered route with an encoded param 404s

1 of 1 case. The fixture prerenders the param `sticks & stones` via
`generateStaticParams`; requesting `/sticks%20%26%20stones` returns the 404 page.
Deterministic.

Hypothesis, from reading rather than measuring: `src/runtime/lambda.mts`
deliberately passes the runtime the raw percent-encoded path, and
`src/runtime/dispatch.ts` looks the resolved pathname up in
`manifest.entrypoints` with a plain property access. If the manifest's keys are
decoded and the request's is not, nothing matches and the miss falls through to
the static 404 — which is what a 404 with no error in the function logs looks
like.

### `app-dir/segment-cache/cached-navigations` — prefetch off the inlined app shell

4 of 14 cases, the same 4 every attempt. Three are the
`… from the initial HTML for subsequent navigations` cases, failing with
`Received a response with an error status code` on a prefetch the client issues
off the inlined app shell. The fourth expects a fully static second navigation to
issue no network requests and sees one.

The other 10 pass, including the equivalents that prefetch from a navigation
rather than from the initial HTML, so this is specific to the HTML-inlined
prefetch path.

### `app-dir/segment-cache/deployment-skew` — RSC request answered as HTML

`header with deployment id › header is set on RSC responses` fetches
`<route>?_rsc=` with an `RSC: 1` request header and expects
`content-type: text/x-component`. It gets `text/html; charset=utf-8` — the HTML
render rather than the flight response. Failed all three attempts.

Not the CloudFront header-quota caveat: `rsc` is in the dynamic cache policy's
allowlist (`src/nextjs-distribution.ts`). Whether the RSC request is lost at the
edge or mishandled by the adapter's request bridge is not established.

### `app-dir/static-rsc-cache-components` — navigation timing never happens

1 of 1 case. `navigates to prerendered route without waiting for dynamic render`
asserts a measured duration is `< 1500` and measures `NaN`, i.e. the navigation
it wanted to time never occurred. Timing-sensitive but not flaky — failed all
three attempts.

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

## No signal — next.js skips these itself

| File                                    | Why                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `app-dir/segment-cache/refresh`         | `describe.skip` upstream, commented `Disabled because too flaky`. Recorded so it is not re-screened: it reports "passing" in ~5s without deploying anything. |
| `app-dir/segment-cache/cdn-cache-busting` | next.js skips it under `isNextDeploy`. Listed as a worked example of deploy mode gating out what cannot work behind a CDN.           |

[harness]: https://nextjs.org/docs/app/api-reference/adapters/testing-adapters
[oac]: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html
