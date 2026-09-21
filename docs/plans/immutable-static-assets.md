# Immutable static assets — `config.supportsImmutableAssets`

Self-contained; assumes no context from the session that wrote it.

Verified against Next.js **16.3.5** (the version in `package.json`) and
[Supporting Immutable Static Assets](https://nextjs.org/docs/app/api-reference/adapters/immutable-static-assets)
/ [`config.supportsImmutableAssets`](https://nextjs.org/docs/app/api-reference/config/next-config-js/supportsImmutableAssets).

## Decision

Opt into `config.supportsImmutableAssets` (default-on, user-overridable), give
the content-addressed assets a year-long `immutable` `Cache-Control`, and stop
`prune-s3.ts` from deleting them out from under live deployments.

**Own branch, own PR.** This was originally Phase 5 of
`docs/plans/adapter-runtime-release.md` and has been split out: it is build-output
processing plus S3/CloudFront wiring, with **no dependency on entrypoint
invocation in either direction**. It can land before or after the adapter runtime
work. Splitting it keeps a runtime rewrite and a static-asset lifecycle change in
separate reviews, since they fail in completely different ways.

The one ordering note: whichever lands second inherits a merge conflict in
`src/adapter/adapter.mts` `modifyConfig` (both add a key to the returned config).
Trivial.

## What the feature does

> When `config.supportsImmutableAssets` is enabled, Next.js outputs immutable
> content-addressed static assets under the public path
> `/_next/static/immutable/*`. […] At runtime, these immutable static assets are
> requested without the `?dpl` query parameter and thus live in a shared
> namespace across deployments. You must ensure that these assets are immutable
> and not changed (even after a new deployment) or deleted (for as long as there
> are active deployments using them).

Two consequences that shape the work:

1. There is a **fixed, predictable prefix** — `_next/static/immutable/` — which
   is what lets S3 and CloudFront treat these objects differently without any
   build-time data handoff into the CDK constructs.
2. Because the filename hash may be truncated, `outputs.staticFiles[].immutableHash`
   carries the **full** content hash so an adapter can detect a collision.
   `config.outputHashSalt` rotates hashes if one is ever found.

Both `supportsImmutableAssets` and `outputHashSalt` are **top-level** config
options in 16.3.5; the `experimental.*` forms are deprecated
(`node_modules/next/dist/server/config-shared.d.ts:1376`, `:1613`).

## Current state (verified, not assumed)

- `src/adapter/adapter.mts` `modifyConfig` sets `output`, `cacheHandler`, and
  `images.customCacheHandler`. It does not touch `supportsImmutableAssets`, so
  the feature is off.
- `NextjsStaticAssets` (`src/nextjs-static-assets.ts:120`) builds its upload from
  the **filesystem**, not from `outputs.staticFiles`: `public/` → staging root,
  `.next/static/` → `staging/_next/static/`. So once the flag is on,
  `_next/static/immutable/*` uploads correctly with zero changes — it's just a
  subdirectory of `.next/static`.
- That single `BucketDeployment` (`:101`) sets **no `cacheControl` at all**,
  tags every object with `metadata: { BUILD_ID }`, and runs with `prune: false`.
- CloudFront's static behavior uses `CachePolicy.CACHING_OPTIMIZED`
  (`src/nextjs-distribution.ts:270`) on the `_next/static*` path pattern
  (`:428`). With no origin `Cache-Control`, edge objects get the policy's 1-day
  default TTL and **browsers get no `Cache-Control` header at all** — heuristic
  caching. So the year-long `immutable` header is a real win at both layers, not
  a formality.
- `prune-s3.ts` deletes any object whose `next-build-id` metadata ≠ the current
  build **and** whose `LastModified` is older than `msTtl` — 30 days
  (`src/nextjs-post-deploy.ts:149`).
- The post-deploy custom resource invalidates `/*` on every deploy
  (`src/nextjs-post-deploy.ts:158`).
- **`deploymentId` is never set anywhere in `src/`**, so Next appends no `?dpl`
  today. Our cache-busting already relies purely on filename hashes. That
  narrows the honest framing of this work: the win is not "we can finally stop
  busting caches per deployment" — it is a *distinct prefix* we can safely mark
  `immutable`, exclude from pruning, and exclude from invalidation.

## Work

**1. `modifyConfig` (`src/adapter/adapter.mts:16`)**

```ts
supportsImmutableAssets: config.supportsImmutableAssets ?? true,
```

Default-on, respecting an explicit `false`. Use `??`, not a truthiness check, or
a user's `false` gets overwritten.

**2. `onBuildComplete` — validate, don't upload**

The constructs upload from the filesystem by prefix, so `onBuildComplete` does
**not** need to drive uploads. Its one job here is collision detection: for each
`outputs.staticFiles[]` with a non-null `immutableHash`, verify that two distinct
full hashes never map to the same `pathname`. Throw with a message naming
`config.outputHashSalt` as the remedy. Cheap, and it's the only place the
truncated-hash risk is visible.

Do not build a manifest handoff from the adapter into the CDK constructs for
this. The prefix is stable and documented; a manifest would be a second source of
truth for the same fact.

**3. `NextjsStaticAssets` — two `BucketDeployment`s**

`BucketDeployment` applies one `cacheControl` to every object it writes, so
per-prefix headers means two deployments over two staging directories:

- **Immutable**: `staging/_next/static/immutable/**` →
  `cacheControl: [CacheControl.setPublic(), CacheControl.maxAge(Duration.days(365)), CacheControl.immutable()]`,
  `prune: false`.
- **Everything else**: current behavior unchanged — `public/` files, the
  non-immutable parts of `_next/static/`, and older Next.js versions that emit no
  immutable directory at all. Keep the `BUILD_ID` metadata.

Notes:

- No new CloudFront cache behavior is needed — `_next/static*` already covers
  `_next/static/immutable/*`, and the header comes from the S3 object. This
  matters because the distribution is already close to CloudFront's 25-behavior
  ceiling (`src/nextjs-distribution.ts:432-435`).
- Re-uploading an immutable object on a later deploy is harmless in content terms
  (same hash ⇒ same bytes) but it **does** rewrite the object's `BUILD_ID`
  metadata and `LastModified`. Don't rely on that for retention; see item 4.
- Handle the case where `.next/static/immutable/` doesn't exist (flag off, or a
  user set `supportsImmutableAssets: false`) by skipping the second deployment
  rather than erroring.
- Both deployments write to the same bucket and the same `destinationKeyPrefix`
  (`basePath`). Verify they don't fight over the same keys — they won't, given
  disjoint staging trees, but CDK will happily create two custom resources racing
  on one bucket, so assert ordering if anything surprising shows up.

**4. `prune-s3.ts` — exclude the immutable prefix**

This is the correctness item. Skip any key under `<basePath>/_next/static/immutable/`
before the `HeadObject` call, so immutable objects are never candidates for
deletion regardless of `BUILD_ID` or age. Excluding by prefix also saves a
`HeadObject` per object, which is the function's dominant cost.

Note what today's logic would do if left alone: an immutable asset still present
in the new build gets re-uploaded with the current `BUILD_ID` and survives; one
that *disappeared* from the build keeps its old metadata and gets deleted 30 days
later. That is not catastrophic, but it is exactly the guarantee the feature asks
us not to break — a rollback to an older deployment, or a client holding a
year-cached reference, can still request it.

**5. `create-invalidation.ts` — leave it, document it**

The `/*` invalidation purges immutable objects from every edge location on every
deploy, forcing needless S3 re-fetches. Narrowing it would mean enumerating
explicit paths, which is more fragile and more expensive in invalidation-path
terms than the single `/*` wildcard. Recommendation: **leave `/*` as-is**, note
the interaction in `docs/`, and revisit only if a real deployment shows the
re-fetch cost mattering. Consumers who care can already override
`createInvalidationCommandInput` via `overrides.customResourceProperties`.

## Tests

- Unit: `prune-s3.ts` skips `_next/static/immutable/` keys — with and without a
  `basePath` — and still prunes a stale non-immutable key in the same listing.
- Unit: the collision check in `onBuildComplete` throws on two different
  `immutableHash` values for one `pathname`, and passes on identical ones.
- e2e (`examples/e2e-tests/`): fetch a `_next/static/immutable/*` asset and assert
  `cache-control: public, max-age=31536000, immutable`; fetch a `public/` asset
  and assert the old behavior is unchanged.
- e2e, the one that actually protects the guarantee: deploy build A, record an
  immutable key, deploy build B, run the post-deploy custom resource, assert
  build A's immutable key is **still fetchable**. Needs the prune TTL overridden
  to something small for the test, since the default grace is 30 days.
- If the official adapter harness is wired up (see the adapter-runtime plan's
  Testing section), the deploy script's `NEXT_SUPPORTS_IMMUTABLE_ASSETS:` marker
  should print `1` once this lands. `0` means the harness never exercises this
  path. The value is `"1"`/`"0"`, not `true`/`false`.

## Open questions

1. **Retention rule.** Immutable objects have no natural expiry tied to
   `BUILD_ID`. "Never delete" is the doc-compliant answer and the one this plan
   assumes, but it grows the bucket without bound. Alternatives: an S3 lifecycle
   rule on the immutable prefix with a long window (1 year?), or a retention
   knob on `NextjsPostDeploy`. Decide before merging; the exclusion in item 4 is
   the same code either way.
2. Should the retention rule be **user-configurable**, and if so on which
   construct — `NextjsStaticAssets` (where the objects are written) or
   `NextjsPostDeploy` (where they're deleted)?
3. Should we set `config.deploymentId` at all, now that immutable assets are
   carved out? It would give the *mutable* assets real per-deployment cache
   busting via `?dpl`, which we currently don't have. Separate concern, but this
   is when the question becomes answerable.
4. Is `supportsImmutableAssets: true` a **breaking change** for consumers? Asset
   URLs move under a new prefix and static responses gain a `Cache-Control`
   header they didn't have. Anyone who pinned a CloudFront behavior, a WAF rule,
   or a response-headers policy to specific `_next/static` paths could be
   affected. Needs a `docs/breaking-changes.md` entry either way, and possibly a
   minor-version bump rather than a patch.

## Exit criteria

- `supportsImmutableAssets` defaults to `true` and an explicit user `false` is
  honored, with a test for each.
- Immutable assets serve `public, max-age=31536000, immutable`; non-immutable
  assets are byte- and header-identical to `main` today.
- `prune-s3.ts` excludes immutable-hash paths, verified by the
  build-A-survives-build-B e2e above.
- Retention rule decided and documented (open question 1), even if the decision
  is "never delete."
- `docs/breaking-changes.md` entry covering the prefix move and the new
  `Cache-Control` header.
