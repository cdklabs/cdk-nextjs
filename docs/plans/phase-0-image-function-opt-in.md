# Phase 0 — Make the dedicated image optimization Lambda opt-in

Handoff plan. Self-contained; assumes no context from the session that wrote it.

## Goal

Land the `feat-nextjs-img-opt` branch **with zero breaking changes** by making the
dedicated image optimization Lambda opt-in (`dedicatedImageFunction`, default
`false`). The default stays what `main` does today: `_next/image` is served by the
Next.js server function.

## Why

The branch currently routes `_next/image` to a dedicated Lambda unconditionally.
That Lambda is not the Next.js server, so **Next.js middleware no longer runs for
image requests** — a real breaking change for anyone whose middleware matcher
covers `/_next/image` (the default matcher `/:path*` does; the matcher
`create-next-app` scaffolds does not).

Making it opt-in means:

- No breaking change, no migration doc.
- The sharp fix in `40b7837` ships now. Without it the dedicated Lambda serves
  every image as unoptimized original bytes with an HTTP 200 and nothing in the
  logs — see "Background" below.
- The flag is not throwaway. A later phase adds a middleware runner to the image
  Lambda (using `outputs.middleware` from the Next.js adapters API), and *that*
  release flips the default and deprecates the flag.

## Starting state

Branch `feat-nextjs-img-opt`. `HEAD` = `40b7837 fix: ship a loadable sharp to the
image optimization Lambda`.

Ten files are **uncommitted** and complete — a second batch of code-review fixes.
All checks were green when they were written (`tsc`, `jest src/` 51 passing,
`eslint`, `jsii`):

| File | What changed |
| --- | --- |
| `src/image-optimization/handler-utils.ts` + `.test.ts` | S3 key derivation now *ensures* the `basePath` prefix instead of stripping it (`NextjsStaticAssets` uploads under `basePath`), and matches `basePath` only on a path boundary so `/basement/logo.png` isn't read as `/base` + `ment/...` |
| `src/image-optimization/handler.mts` | 304 responses only write the API-Gateway-appeasing space byte on the API Gateway path (RFC 9110 forbids a body on 304); adds `isApiGatewayEvent` type guard |
| `src/utils/get-architecture.ts` | `getNodeArchitecture()` as the single source of truth, replacing two inline `process.arch.startsWith("arm")` copies |
| `src/nextjs-build/nextjs-build.ts` | Uses `getNodeArchitecture()` |
| `src/root-constructs/nextjs-base-construct.ts`, `nextjs-global-functions.ts`, `nextjs-regional-functions.ts`, `src/index.ts` | New `NextjsFunctionsConstructOverrides` holds `nextjsFunctionsProps` / `nextjsImageFunctionProps`, which the Containers constructs previously accepted and silently ignored |
| `docs/breaking-changes.md` | Two new `## 0.6.0` sections |

### Step 0 — commit them first

```
git add -A && git commit
```

Suggested message: `fix: correct image optimization basePath keys, 304 bodies, and Functions-only overrides`

Commit as-is even though Step 5 deletes one of the breaking-changes sections it
adds — each commit stays internally consistent, and the sections are removed in
the same PR.

## Design decisions (already made — don't relitigate)

**Flag name:** `dedicatedImageFunction?: boolean`, `@default false`.

**Where it goes:** three sibling interfaces.

- `NextjsBaseConstructProps` (`src/root-constructs/nextjs-base-construct.ts:124`)
  — so `NextjsBaseConstruct` can read `this.baseProps.dedicatedImageFunction`
  when it builds `NextjsBuild`.
- `NextjsGlobalFunctionsProps` (`src/root-constructs/nextjs-global-functions.ts:47`)
- `NextjsRegionalFunctionsProps` (`src/root-constructs/nextjs-regional-functions.ts:43`)

**Not** on `NextjsBaseProps` — the Containers constructs would accept it and
silently ignore it, which is the exact anti-pattern the uncommitted
`NextjsFunctionsConstructOverrides` change fixes.

> JSII note: all three interfaces extend `NextjsBaseProps` but none extends
> another, so declaring the same member on all three is legal. Declaring it on
> both a parent and a child interface is **not** — that produces
> `Interface ... re-declares member`, the error documented at
> `nextjs-base-construct.ts:120-123`.

**Why a boolean and not an enum:** JSII rejects string-literal union types, so a
`"server" | "dedicated"` choice would need a real exported enum. Not worth it for
a flag that gets deprecated in two releases.

## Tasks

### 1. `src/nextjs-build/nextjs-build.ts` — the part that will bite

Add `dedicatedImageFunction?: boolean` to `NextjsBuildProps`, then rework the
constructor block at **lines 132-152**.

Current logic strips whatever platform sharp binaries output file tracing
bundled, then installs musl replacements **only for Containers**, on the
assumption that Functions deployments never invoke sharp from the standalone
server. That assumption is exactly what this flag breaks.

```ts
const useDedicatedImageFunction =
  isFunctions && props.dedicatedImageFunction === true;

this.removeExistingSharpBinaries(standalonePath);
// The standalone server serves `_next/image` itself unless a dedicated image
// Lambda takes that route, and it runs on node:24-alpine (see
// functions.Dockerfile), so it needs musl binaries.
if (!useDedicatedImageFunction) {
  this.downloadAndInstallSharpBinaries();
}
if (useDedicatedImageFunction) {
  this.imageOptimizationAssetPath =
    this.prepareImageOptimizationAssets(standalonePath);
}
```

**Get this right or Phase 0 ships broken image optimization on the default
path.** `removeExistingSharpBinaries()` runs unconditionally and deletes the
host's (macOS/glibc) binaries. If the musl install doesn't run for Functions
deployments that no longer have a dedicated image Lambda, `require('sharp')`
throws inside the server, Next.js's `imageOptimizer` catches it internally and
returns the *original* buffer, and you get an HTTP 200 with plausible headers
serving unoptimized images. Silent. This is the same failure the branch already
fixed once for the dedicated Lambda; don't reintroduce it on the default path.

Also update the comment at lines 137-143, which currently states the now-
conditional claim as fact.

Adding a prop to `NextjsBuildProps` means `OptionalNextjsBuildProps` must be
regenerated — see Verification.

### 2. `src/root-constructs/nextjs-base-construct.ts`

- Add the prop to `NextjsBaseConstructProps`.
- Pass it into `NextjsBuild` in `createNextjsBuild()` (line 195).
- `createNextjsImageFunction()` (line 251) keeps throwing when
  `imageOptimizationAssetPath` is missing — that's still a genuine invariant
  violation, since callers only reach it when the flag is on.

### 3. The two Functions root constructs

Make the field optional and conditional:

```ts
nextjsImageFunction?: NextjsImageFunction;
// ...
if (props.dedicatedImageFunction) {
  this.nextjsImageFunction = this.createNextjsImageFunction(
    this.props.overrides?.nextjsImageFunction,
  );
}
```

- `nextjs-global-functions.ts:67` (field), `:83` (creation), `:95` — pass
  `imageFunctionUrl: this.nextjsImageFunction?.functionUrl`.
- `nextjs-regional-functions.ts:56` (field), `:76` (creation), `:87` — pass
  `imageFunction: this.nextjsImageFunction?.function`.

An optional class property is fine for JSII (`NextjsBuild.imageOptimizationAssetPath`
already is one).

### 4. Make the two consumers tolerate a missing image function

**`src/nextjs-api.ts`** — revert this branch's tightening:

- `validateProps` (line 110-114): drop the "imageFunction must be set when
  serverFunction is set" throw.
- Constructor (line 97-100): call `createImageIntegration` only when
  `props.imageFunction` is set. With no image integration, `_next/image` falls
  through to the `{proxy+}` catch-all on the server function — which is what
  `main` does.
- Update the `imageFunction` doc comment (line 53-62): no longer "Required if
  `serverFunction` is set".

**`src/nextjs-distribution.ts`** — `createImageOrigin()` (line 201-215) already
falls back to `this.dynamicOrigin` for non-Functions compute. Extend that
fallback instead of throwing:

```ts
if (!this.isFunctionCompute || !this.props.imageFunctionUrl) {
  return this.dynamicOrigin;
}
```

Keep the dedicated `_next/image*` behavior and its image-specific cache policy
in both cases — pointing that behavior at the dynamic origin is strictly better
than dropping it, because the image cache policy (`queryStringBehavior: all()`,
`accept` in the cache key) is the right one for image requests either way. Update
the doc comment on `imageFunctionUrl` (line 79-83) and on `createImageOrigin`.

### 5. `docs/breaking-changes.md`

From the `## 0.6.0` section added in Step 0:

- **Delete** "`_next/image` no longer runs Next.js middleware (Functions only)".
  It isn't true once the flag defaults off.
- **Rewrite** "NextjsApi: `imageFunction` now required alongside
  `serverFunction`" — it's optional again. Either delete it or restate it as a
  non-breaking addition.
- **Keep** "Functions-only overrides moved off the Containers constructs". That
  one is a real (tiny) breaking change and it ships.

Document the trade-off on the new prop's JSDoc, since that's what users will
read:

- **off (default)** — middleware runs for image requests; on Regional Functions
  the response goes through API Gateway buffered (6 MB cap); images share the
  server function's memory and concurrency; optimized images are cached via the
  configured `cacheHandler`.
- **on** — dedicated Lambda with response streaming and independent sizing; no
  middleware for `_next/image`; caching relies on CloudFront.
- Note that a future release will default this on once middleware support lands.

### 6. Examples and e2e

Set `dedicatedImageFunction: true` in **`examples/global-functions/app.ts`** only.
Leave `examples/regional-functions/app.ts` on the default. That way CI covers
both paths: `glbl-fns` exercises the dedicated Lambda, `rgnl-fns` exercises the
server-function path.

`examples/e2e-tests/src/image-optimization.test.ts` should pass unchanged on both
— including the `content-type: image/webp` assertion added in `40b7837`, since
the server function re-encodes with sharp too (that's what Task 1 guarantees).
If it fails on `rgnl-fns`, suspect the musl install, not the test.

### 7. Stretch — first construct test

`test/` currently holds only a `tsconfig.json`; there are no CDK assertion tests.
A worthwhile addition: with the flag off, assert the synthesized template has one
Lambda and the `_next/image*` cache behavior targets the server origin; with it
on, two Lambdas. The obstacle is that `NextjsBuild` runs `next build` in its
constructor, so a test needs `skipBuild: true` plus a committed fixture `.next`
directory. Skip if it balloons; it's not a Phase 0 blocker.

## Verification

```bash
npx tsc --noEmit -p tsconfig.json
npx jest src/                                       # 51 tests before this change
ESLINT_USE_FLAT_CONFIG=false npx eslint --fix --ext .ts src/
npx jsii --silence-warnings=reserved-word
```

Then, because `NextjsBuildProps` changed, in this order (the build-order quirk in
`CLAUDE.md`):

```bash
pnpm compile      # writes .jsii
pnpm projen       # regenerates src/generated-structs/OptionalNextjsBuildProps.ts from .jsii
pnpm build
npx jsii-docgen -o API.md   # API.md is committed and generated from .jsii
```

Notes:

- `pnpm eslint` and `pnpm projen` shell out to `pnpm dlx projen`, which needs
  network access to `registry.npmjs.org`. In a sandboxed session that fails with
  `ERR_PNPM_FETCH_403`; the `npx` forms above work around it.
- `src/image-optimization/handler.mts` cannot be linted — pre-existing, the
  ESLint project service only covers `.ts`/`.tsx`.
- `API.md` is 11,973 lines and committed. Forgetting to regenerate it will show
  up as a CI self-mutation diff.

## Out of scope

- Any middleware execution. That's the next phase: copy
  `ctx.outputs.middleware.filePath` + `assets` in `onBuildComplete`, match on
  `config.matchers[].sourceRegex` with `has`/`missing`, invoke the entrypoint's
  exported `handler(req, res, ctx)`. Node runtime only — edge is deprecated in
  Next.js 16.
- Replacing the server function with adapter entrypoints.
- Widening the image cache policy's `cookieBehavior` (currently `none()` at
  `nextjs-distribution.ts:338`). Only matters once middleware makes
  cookie-dependent decisions for image requests.

## Background: the bug that started this

`next/dist/server/image-optimizer.js` reports a failed optimization by
**returning** `{ buffer: upstreamBuffer, ..., error }` rather than throwing. The
handler dropped `error`, so a broken sharp produced a valid HTTP 200 serving
full-size originals forever, with clean logs. It got through four green e2e jobs
and a live CloudFront endpoint that rendered all three test images correctly.

It was caught by comparing bytes: the `_next/image` response was byte-identical
to the raw S3 asset (31,283 bytes, md5 `ac38a73ecb20a904d52ebc9b28aa171f`),
returned `content-type: image/png` despite `Accept: image/webp`, and carried
S3's MD5 ETag rather than Next.js's sha256/base64url one.

Root cause: `next build`'s output file tracing preserves the installer's layout,
and under pnpm there is never a hoisted `node_modules/sharp` — only
`node_modules/.pnpm/sharp@<version>/node_modules/sharp`. The old flat
`existsSync` check never matched, so sharp was never bundled. Fixed in `40b7837`
along with logging the swallowed `error`.

The lesson for every later phase: the e2e suite asserts status codes, so it
cannot see semantically wrong but syntactically fine responses. Assertions on
bytes and headers are what caught this.
