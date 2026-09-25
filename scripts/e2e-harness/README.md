# Next.js compatibility harness

Runs [vercel/next.js's own e2e suite][harness] against a real cdk-nextjs
deployment. It is a better correctness signal than any fixture app we would
write, because the tests were written by the people who define the behavior.

`examples/e2e-tests/` remains the per-commit gate on all four `NextjsType`s. This
is the scheduled one — every sixth day of the month at 14:00 UTC, so the day of
the week drifts — on `NextjsGlobalFunctions` only.

What has actually been run, what failed, and whether each failure is a bug or
acceptable: [`docs/harness-coverage.md`](../../docs/harness-coverage.md).

## Pieces

| Path                                | Role                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `scripts/e2e-deploy.sh`             | `NEXT_TEST_DEPLOY_SCRIPT_PATH`. Installs, builds through the adapter, deploys, invalidates, prints the URL.        |
| `scripts/e2e-logs.sh`               | `NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH`. Replays the build markers and the build log — and, under `HARNESS_VERBOSE_LOGS=1`, the deploy log and the Lambda's CloudWatch tail. |
| `scripts/e2e-cleanup.sh`            | `NEXT_TEST_CLEANUP_SCRIPT_PATH`. A no-op in shared-stack mode; deletes the stack under `HARNESS_ISOLATED_STACK=1`. |
| `scripts/e2e-warm.sh`               | Creates this shard's shared stack before the suite starts, so no test file pays for it. Run it first.              |
| `scripts/e2e-sweep.sh`              | Deletes orphaned harness stacks, and a shard's own after its run. Dry run unless `--apply`.                        |
| `scripts/e2e-harness/app.js`        | The CDK app the deploy script deploys.                                                                             |
| `scripts/e2e-harness/stage-proxy.mjs` | Localhost front door for a `NextjsRegionalFunctions` stack: puts the stage back. Regional only. |
| `scripts/e2e-harness/common.sh`     | Shared file names, stack naming, output reads, and the tag check that gates every delete.                          |
| `.github/actions/build-nextjs`      | Checks out and builds vercel/next.js. The cache-miss path, shared by the `nextjs` job and a shard's fallback.      |
| `test/deploy-tests-manifest.json`   | Which next.js test files run (`NEXT_EXTERNAL_TESTS_FILTERS`).                                                      |
| `.github/workflows/e2e-harness.yml` | Every six days + `workflow_dispatch`. A matrix of `shard_total` jobs, one stack each.                              |

## One shared stack, not one per test file

The harness creates an isolated app per test file and runs the deploy script with
`cwd` set to it, so there is no way to deploy once and point the whole suite at
one deployment — every file genuinely has different code to ship. What there is a
way to do is ship it into infrastructure that already exists.

Every test file in a run deploys into the same stack (`hrns-shared` by default,
`hrns-shard-<n>` under the workflow's matrix — see "Sharding" below) with
`cdk deploy --hotswap-fallback`. Creating and propagating the CloudFront
distribution costs ~4 minutes once per stack; every test file reuses it. That is
the whole saving, and it is most of the cost of a run.

`scripts/e2e-warm.sh` pays that cost **before `run-tests.js` starts**, and
is not optional. The harness calls `createNext` inside jest's `beforeAll`, so a
stack create is charged against `NEXT_E2E_TEST_TIMEOUT` (240s in CI) and the
first test file fails wholesale, then passes on retry once the stack exists.
Measured: unwarmed, the first file failed all 11 tests at 242s and passed on
retry 1 in 213s; against an already-created stack, a file passes on its first
attempt in 107s. Retries make that survivable, not correct - it spends a retry
the next real failure needs, and a create slower than two retries goes red.

Measured against two different built apps (`cdk synth` twice into the same stack
name, then diffing the templates), exactly five resources differ between two
fixtures:

| Resource                        | Changed properties                  | Hotswappable |
| ------------------------------- | ----------------------------------- | ------------ |
| `AWS::Lambda::Function`         | `Code`, `Environment`               | yes          |
| `Custom::CDKBucketDeployment`   | `SourceObjectKeys`                  | yes          |
| `Custom::CDKBucketDeployment`   | `SourceObjectKeys`, `UserMetadata`  | yes          |
| `AWS::S3::Bucket`               | `Tags`                              | **no**       |
| `AWS::CloudFront::Distribution` | `DistributionConfig.CacheBehaviors` | **no**       |

Both of the un-hotswappable rows fire in practice, and the bucket's `Tags` fired
far more often than the distribution. Measured over batch 9, a 23-file run with
22 deploy invocations:

| Deploy path                             | Count | Cost  |
| --------------------------------------- | ----- | ----- |
| fallback, cache bucket `Tags` rejected  | 19    | ~110s |
| fallback, `DistributionConfig` rejected | 3     | ~110s |
| hotswap                                 | 0     | ~52s  |

- The **cache bucket's `Tags`** were the dominant cost, at ~110s of a ~157s median
  green file. `BucketDeployment` unconditionally tags its destination bucket
  `aws-cdk:cr-owned:<destinationKeyPrefix>:<hash>`, and the init cache deployment
  passed the build ID as its `destinationKeyPrefix` — so the tag key, and
  therefore the bucket's `Tags`, changed on every fixture. The hotswap attempt
  itself took 0.77s before falling back.

  Fixed: the build ID is now part of the staged asset's own paths and the
  deployment has no `destinationKeyPrefix` (`src/nextjs-cache.ts`). The S3 keys
  are unchanged; the tag key is constant. An earlier 13-file measurement recorded
  in this file claimed the tag never blocked a deploy — it was wrong, and batch 9
  is the run that showed it.

- The **distribution** blocks the remainder. Its cache behaviors change when a
  fixture's `public/` directory differs from the previous one's, since `public/`
  entries become behaviors (`src/nextjs-distribution.ts`). CloudFront then has to
  propagate, which is the irreducibly expensive case.

Either way the shared stack wins: even a full CloudFormation update that leaves
the distribution alone costs ~110s, against ~4 minutes for a stack of its own plus
a slow delete.

What that means for the timeout, because it is the single most common way to
misread a run: a ~52s hotswap is **not** the whole `beforeAll`. Isolating the
fixture, `pnpm install`, `next build` and the CloudFront invalidation wait are
charged against `NEXT_E2E_TEST_TIMEOUT` too, and the sum passes 120s for most
files even on the fast path. See "Running it locally".

What the shared stack is paid for in:

- **Test files must be serialized within a stack** (`run-tests.js -c 1`). Two
  concurrent deploys into one stack would race. Parallelism comes from more
  stacks — see "Sharding" below.
- **`e2e-cleanup.sh` must not delete the stack**, or the next file pays the
  create again. It doesn't; `e2e-sweep.sh --apply --shared` deletes it once,
  after the run. The workflow does this in an `always()` step; a local run has to
  do it by hand.
- **Nothing may leak between files.** Server cache entries are keyed by
  `CDK_NEXTJS_BUILD_ID` (`src/adapter/s3-cache-handler.ts`), which differs per
  file and hotswaps with the function. The edge cache is invalidated by
  `e2e-deploy.sh` before it reports the URL — which it has to do itself, since a
  hotswap never runs CloudFormation and therefore never runs the post-deploy
  custom resource that normally invalidates. `app.js` pins that resource's
  properties for the same reason: its default `buildId` and invalidation caller
  reference change on every synth, and a changed custom-resource property is not
  hotswappable, so either one alone would drag the deploy back through
  CloudFormation.

`test/deploy-tests-manifest.json` still lists test files explicitly rather than
taking next.js's `test/e2e/**` include rule, and this still runs on a schedule
rather than per-commit. Widen either deliberately - and only with files you have watched
pass, since a file can be unbuildable rather than merely failing (see below).

`HARNESS_ISOLATED_STACK=1` gives a stack per app directory instead — worth it to
debug a single file, at the cost of a distribution create and delete per file. To
run two _suites_ at once, give each its own shared stack with
`HARNESS_SHARED_STACK_SUFFIX` rather than paying that per file.

## Sharding: one stack per shard

A stack holds one app at a time, so the only way to run two test files at once is
to give them two stacks. `HARNESS_SHARED_STACK_SUFFIX` is that knob, and
`.github/workflows/e2e-harness.yml` turns it into a matrix: `shard_total` jobs
(10 by default), each with a shared stack named `hrns-shard-<n>` and each running
its own slice of the file list.

The slice comes from next.js's own `run-tests.js -g <n>/<N>`, which splits
**after** `NEXT_EXTERNAL_TESTS_FILTERS` has been applied — `run-tests.js` filters
the glob, dedupes, _then_ groups — so the shards partition
`test/deploy-tests-manifest.json`, not the whole of `test/e2e/**`. With no
`KV_REST_API_URL`/`KV_REST_API_TOKEN` configured (we have none) it warns and falls
back to round-robin over that list, which is deterministic and near enough: cost
per file here is dominated by build-and-deploy, which barely varies, not by how
long the tests take. If it ever stops being near enough, `run-tests.js` reads a
`test-timings.json` from its own cwd before it tries KV, and a `--timings` run
prints per-file durations to build one from.

Each shard is self-contained, which is what makes this safe:

- `e2e-warm.sh` warms _its_ stack, so the ~4-minute distribution create is paid
  once per shard but in parallel — the same ~4 minutes of wall clock however many
  shards there are.
- `e2e-sweep.sh --apply --shared` in an `always()` step deletes _its_ stack, since
  `--shared` resolves the same suffix. Nothing lowers the age floor account-wide,
  so one shard finishing early cannot delete another's stack out from under it.
- `fail-fast: false`, because one shard's failure says nothing about another's and
  cancelling the others would leave their stacks to the next scheduled sweep - up
  to six days later - instead of to their own cleanup step.
- `-c 1` stays mandatory _within_ a shard. Sharding adds stacks; it does not make
  one stack safe to deploy into twice at once.

What sharding does **not** make cheaper is **total AWS spend**: the same number of
deploys happen, plus N-1 extra distribution creates and deletes. It is wall clock
that improves, not cost. Nor does it divide the next.js build — see below.

Two runs must never overlap, because they would reuse the same shard names; the
workflow's `concurrency` group is what guarantees that, and it queues rather than
cancels.

## Caching the next.js build

Every shard needs a _built_ vercel/next.js checkout — `run-tests.js` and
`test/lib` are repo files, and the tests run against `packages/next/dist`. That is
a fixed per-shard cost which sharding **multiplies rather than divides**, and once
the test time is divided by ten it is the largest thing left in a run.

The shape of the fix is forced by two facts:

- **The shards start simultaneously.** Matrix jobs are concurrent, so within one
  run no shard can benefit from another's cache save — all ten would miss
  together, all ten would build, and nine saves would lose the race harmlessly.
  A cache on the shard alone therefore does nothing for the run that writes it.
  So the build belongs in a **`nextjs` job ahead of the matrix**, which every
  shard then restores from. On a hit that job is a `lookup-only` restore and
  nothing else (~15s — it does not download, since the shards are about to). On a
  miss it builds and saves, costing the run what it used to cost _every_ shard.
- **GitHub evicts a cache entry not _accessed_ in 7 days.** A weekly schedule sits
  exactly on that boundary, and past it as soon as a scheduled run is delayed
  under load, which they routinely are. So the schedule is **every six days**
  instead: `0 14 */6 * *`, by day-of-month rather than day-of-week. Every run's
  shards restore the entry, so a cadence strictly under 7 days keeps it warm with
  no extra machinery.

That second point is why the cron looks the way it does, and it is load-bearing.
`*/6` expands to days 1, 7, 13, 19, 25 and **31** — standard cron steps from the
range's start, so the 31st is included, which is what makes the month boundary a
1-day gap rather than a long one. Enumerated over 2026–2029 the gaps are 6 days
within a month and 1, 4 or 5 across a boundary; never 7. Dropping the 31st, or
reaching for `*/7`, puts the boundary straight back.

Two costs, both accepted deliberately: ~67 runs a year instead of 52, and a run
day that **drifts through the week** — so read a run's results whenever it lands
rather than on a fixed morning. In exchange there is no keep-alive job and no
schedule-gated `if:` on anything.

Eviction is in any case a speed problem and not a correctness one: if the entry is
gone, the `nextjs` job rebuilds it once and the shards still find it. The cadence
buys the fast path, not the working one.

`.github/actions/build-nextjs` holds the build itself, so the `nextjs` job and a
shard's miss-path fallback cannot drift. A shard that misses logs a `::warning`
and rebuilds rather than failing: a slow run still produces the signal the run is
for.

What is cached is the whole `nextjs` directory plus `~/.cache/ms-playwright`,
keyed on the next.js ref and the runner image and node major its `node_modules`
were installed against (`plan` computes the key, so every job agrees on it; bump
the `v1` in it to discard every entry). Two things to know:

- **A repository gets 10 GB of cache in total, evicted least-recently-used.** An
  entry this size can displace every other workflow's. The `nextjs` job prints
  `du -sh` of what it is about to save for exactly that reason — the number worth
  comparing against is whatever the other workflows are using at the time.
- **The Playwright _browser_ is cached; its system libraries are not.** Those are
  apt packages outside any cacheable path, so
  `playwright install --with-deps chromium` still runs in each shard. It is a
  no-op for the download on a hit.

A `workflow_dispatch` from a branch writes to that branch's own cache scope, so
the first dispatched run on a new branch pays the build once. It can still _read_
the default branch's entry, so this only bites when the ref differs too.

## Running two of them at once locally

Set a suffix per session and the same rules apply:

```bash
HARNESS_SHARED_STACK_SUFFIX=fix-a ADAPTER_DIR=$PWD ./scripts/e2e-warm.sh
# ... and export it for run-tests.js too, then afterwards:
HARNESS_SHARED_STACK_SUFFIX=fix-a ./scripts/e2e-sweep.sh --apply --shared
```

What does _not_ parallelize as easily is the next.js checkout. `run-tests.js`
writes its results and timings into its own cwd, and `e2e-offline.sh` stages the
app inside the checkout, so two concurrent sessions want two checkouts (`NEXTJS_DIR`
points `e2e-offline.sh` at one; `run-tests.js` has to be run from one). Two
sessions on _different_ fixtures can share a checkout through `e2e-offline.sh` —
its app directory is named after the fixture and it takes a port argument — but
two on the same fixture will `rm -rf` each other's.

Nor does the _fixing_ parallelize the way the running does. A fix lands in the
adapter and the runtime (`src/adapter/`, `src/runtime/`), which is where every
harness failure leads, so two sessions each on their own branch will conflict far
more often than two on separate features would. Parallelize the _diagnosis_ —
`e2e-offline.sh` is read-only against this repo, and several sessions can bisect
several failures at once — and land the fixes one at a time, each rebased on the
last. A session that must have its own working tree wants a `git worktree` _and_
its own next.js checkout _and_ its own stack suffix; three of those is usually the
point at which running one at a time is the cheaper answer.

## Why `NextjsGlobalFunctions`

The harness builds every request URL as `new URL(path, deploymentUrl)` —
`getFullUrl` in `test/lib/next-test-utils.ts` assigns `pathname` outright — so any
prefix in the deployment URL is dropped. That rules out both Regional types:
their API Gateway REST URL is always
`https://<id>.execute-api.<region>.amazonaws.com/<stage>`, and every absolute
path the suite requests would miss the stage and 404. A CloudFront distribution
is served at the origin root. (`NextjsRegionalFunctions` can still be run, behind
a local proxy that puts the stage back — see "Running on
`NextjsRegionalFunctions`" — but that is a second front door, not the one users
deploy, so it stays the exception.)

It is also the front door the suite was written for. `NEXT_TEST_MODE=deploy` is
the mode Vercel validates edge-fronted deployments with, so its tests tolerate a
CDN in front of them, and the ones that cannot are already gated out of deploy
mode upstream. Serving through CloudFront means `_next/static` and `public/` are
answered by the `NextjsStaticAssets` bucket exactly as in production, rather than
by some harness-only arrangement.

What `app.js` reports as the deployment URL is the distribution's bare origin,
deliberately not `NextjsGlobalFunctions#url` — that property appends the app's
`basePath`, and the fixtures are written against a Vercel deployment URL, which
has neither a path nor a trailing slash. `new URL(path, deploymentUrl)` would not
care, but plenty of tests interpolate instead (`` `${next.url}${path}` `` with
`path` already carrying the basePath), and a prefix or a trailing slash there
shows up as `/base//base/refresh`. Reporting the origin took
`app-dir/app-basepath` from 7 failures to 3.

Two caveats worth knowing before reading a failure as a regression:

- The dynamic cache policy allowlists ~10 request headers, a CloudFront quota
  limitation documented at `src/nextjs-distribution.ts`. A test that varies on a
  header outside that list can be served a wrong cached response. That is a real
  product limitation, not a harness artifact — and not a regression either.
- `NextjsGlobalContainers` and `NextjsRegionalContainers` are not covered here
  at all, and `NextjsRegionalFunctions` only by hand (see "Running on
  `NextjsRegionalFunctions`"). `examples/e2e-tests` is the gate on all three.

## Running on `NextjsRegionalFunctions`

`HARNESS_NEXTJS_TYPE=regional-functions` deploys `NextjsRegionalFunctions`
instead, into `hrns-rf-<suffix>` stacks so it can never land in a Global run's.
Local and manual for now; the scheduled workflow is Global only.

The stage is the whole problem, and `stage-proxy.mjs` is the whole answer. The
suite discards any path in the deployment URL (above), and a REST API's is always
`.../<stage>`. So `e2e-deploy.sh` starts a localhost proxy per stack that adds the
stage to every request path and reports `http://127.0.0.1:<port>` as the
deployment URL. The fixture is deployed as built. API Gateway strips the stage
again, so the app sees what it would at a custom domain mapped at the root. The
proxy outlives each test file; `e2e-cleanup.sh` and `e2e-sweep.sh` stop it
alongside the stack delete.

Three things the regional deploy does that the Global one does not:

- **The fixture's `basePath` becomes the construct's `basePath` prop.** Synth
  would derive the same resource path, but it would also warn that the app's
  links miss the stage, which is true of the execute-api URL and not of the
  proxy. Before derivation existed (see `docs/harness-coverage.md`), leaving it
  unset 404'd every `_next/static` request.
- **The proxy sends `x-forwarded-host: 127.0.0.1:<port>`**, because it has to
  send the execute-api `Host` for API Gateway to route. Without it every server
  action fails Next.js's CSRF check (`host` … does not match `origin`).
- **It waits for the stage to settle** before reporting the URL. A fixture whose
  `basePath` differs from the previous one's changes the resource tree, and API
  Gateway kept answering the replaced tree (403 `MissingAuthenticationToken`,
  then 500s) for ~90s after CloudFormation reported `UPDATE_COMPLETE`, unevenly
  across requests. So it waits until the base path, `_next/static` and the
  catch-all have all stayed healthy for five rounds in a row.

What it cannot do: a fetch the **server** makes to its own origin. The origin is
`127.0.0.1` on the machine running the suite, and the Lambda cannot reach that.
Next.js does this to stream a server action's `redirect()` target in one round
trip, and some fixtures do it themselves. Such a case fails here with
`ECONNREFUSED 127.0.0.1` in the function's log. That's the harness, not
cdk-nextjs: a real deployment's origin is its own public URL.

First run, 22 files (the 12 picked plus the manifest's `suites` for them), on
2026-09-24: **17 green**. Of the other 5, 3 are the self-fetch limitation above
(`actions-streaming`; 3 of `app-basepath`'s 13 cases; 1 of
`redirect-rewrite-dynamic-basepath`'s 2), and 2 are the `assetPrefix` variants of
`invalid-static-asset-404-*`, which the regional types do not serve (cdk-nextjs
warns at synth). Full record in `docs/harness-coverage.md`.

```bash
ADAPTER_DIR=$PWD HARNESS_NEXTJS_TYPE=regional-functions ./scripts/e2e-warm.sh
# ...then the usual run from the next.js checkout, with the same
# HARNESS_NEXTJS_TYPE exported, and afterwards:
HARNESS_NEXTJS_TYPE=regional-functions ./scripts/e2e-sweep.sh --apply --shared
```

## Which test files can run at all

cdk-nextjs rejects any build output whose runtime is not `nodejs`
(`assertNodeRuntimes` in `src/adapter/build-outputs.ts`), and it throws during
`next build`. So a fixture containing even one edge route, or a legacy edge
`middleware.ts`, does not fail some tests - it fails to build, and no per-case
`failed` entry in the manifest can rescue it. Such files have to stay out of
`rules.include`.

That is a product limitation and a deliberate one: the edge runtime is deprecated
in Next.js, and cdk-nextjs supports Next.js 16's Node-runtime `proxy.ts` instead.
931 of next.js's 1134 e2e files are edge-free, so it barely constrains widening
the list - and `scripts/e2e-harness/screen.mjs` applies this screen and the three
below for you, recording the funnel in the manifest's `screening` block:

```bash
node scripts/e2e-harness/screen.mjs --next ../next.js          # print the funnel
node scripts/e2e-harness/screen.mjs --next ../next.js --check   # fail if stale
node scripts/e2e-harness/screen.mjs --next ../next.js --list cache   # candidates
```

To check one candidate by hand instead:

```bash
# in the next.js checkout, against the fixture root (usually the test file's dir
# or its parent)
find <fixture> -name "middleware.*"
grep -rlE "runtime\s*[:=]\s*.(experimental-)?edge." <fixture>
```

Both spellings matter — app router's `export const runtime = 'edge'` and pages
router's `export const config = { runtime: 'experimental-edge' }`. Matching only
the first undercounts by ~17 files.

Mind the "or its parent": for a `test/e2e/<name>/test/index.test.ts` the fixture
lives a directory _above_ the test file, and screening only the test file's own
directory quietly misses its `middleware.js`.

Six more screens are worth running before spending a deploy on a candidate, all
against the test file rather than the fixture:

- `skipDeployment: true` in the `nextTestSetup` call — next.js replaces the whole
  file with `it.only('should skip next deploy')` and sets `skipped`, so the body
  early-returns (`test/lib/e2e-utils/index.ts`). The costliest screen to have been
  missing: it accounts for a third of what was previously counted as the candidate
  pool, and two files reached `rules.include` on the strength of a 4s "pass".
- `describe.skip` / `(isNextDev ? describe : describe.skip)` — a file skipped
  upstream reports as passing in a few seconds without deploying anything, and
  adding it to `rules.include` claims coverage that does not exist. This screen
  over-reports: the match is textual, so a skip conditional on something the
  harness does not set is caught too. `incremental-cache-path-traversal` is one
  (`__NEXT_CACHE_COMPONENTS`), it runs fine, and it found a real defect. Re-read
  any file this screen alone disqualifies.
- An empty `it('should skip …', () => {})` — the stub next.js writes for the modes
  a _mode-gated_ file does not cover, its real cases sitting inside
  `if (isNextStart)` or `if (isNextDev)`. `app-fetch-deduping` reported a pass in
  5.9s having deployed nothing. A stub whose title names _dev_ is the opposite
  case — the file runs everywhere but dev — so those are left in
  (`app-prefetch-static`).
- `isNextDeploy` — usually next.js itself gating out what cannot work behind a
  CDN. Not always disqualifying, but read the gate before adding the file.
- `output: 'export'` in the fixture — a static export is not what any
  `NextjsType` deploys.
- An entry in the manifest's `excluded-notes` — the file already has a written
  verdict, so it has been decided and should not reappear as a candidate. Keys that
  start with `test/e2e/` are matched (`…/**` matches the tree); the prose keys like
  `"edge runtime, generally"` are not. Without this screen a decided file stays a
  candidate forever: the `next-config-ts-native-ts` family would have been picked
  for a second batch and burned 18 more deploy slots on a build that cannot
  succeed.

None of these is watertight — each is a textual match on a convention next.js is
under no obligation to keep. The measured backstop covers all of them: **a file
that passes in under ~10 seconds deployed nothing.** Check the `--timings`
duration before believing a pass. That is how the mode-gated screen above came to
be written, after `app-fetch-deduping` spent a deploy slot to report a 5.9s
pass.

`excluded-notes` in the manifest records every file left out and why, and its
`screening` block records the funnel — how many files there are, how many survive
each screen, and how many are already included. Regenerate it with `--write`
whenever `next` is upgraded; `--check` exits nonzero if it has drifted, which is
the only thing that keeps those numbers worth quoting.

Passing every screen makes a file a _candidate_, not a pass. It still has to
be deployed and watched, and anything that fails gets root-caused and given a
verdict in `docs/harness-coverage.md` before it is either fixed or written off.

## Keeping the passing part of a partly-failing file

Written off does not have to mean the whole file. A file listed in the manifest's
`suites` is **included**, with the cases named in its `failed` array skipped —
next.js's `test/get-test-filter.js` turns them into `excludedCases` and
`run-tests.js` passes them as a negative `--testNamePattern`. That is the right
home for a file whose residual failures already have an _acceptable_ verdict, and
it is how `trailingslash` contributes 6 of its 8 cases:

```json
"suites": {
  "test/e2e/app-dir/trailingslash/trailingslash.test.ts": {
    "failed": ["app-dir trailingSlash handling should revalidate a page with generated static params (withSlash=true)"],
    "flakey": []
  }
}
```

Two things to get right. The names are full jest names — every enclosing
`describe` title, space-joined, and for `it.each` the interpolated title, so
`(withSlash=$withSlash)` has to be spelled out per case. And a `failed` entry is
never how a cdk-nextjs bug gets handled: fix it, or give it a verdict first.
Add a `comment` array to the entry naming the verdict it stands on.

## Running it locally

Needs a next.js checkout at the tag matching this repo's `next` version, built
once (`pnpm install && pnpm build && pnpm install` in it — `run-tests.js` and
`test/lib` are repo files, not published ones), and AWS credentials that can
deploy.

```bash
# in the cdk-nextjs checkout
pnpm i && pnpm bundle && pnpm compile

# create the shared stack before the suite runs; ~4 minutes, once
ADAPTER_DIR=$PWD ./scripts/e2e-warm.sh

# in the next.js checkout
export ADAPTER_DIR=/path/to/cdk-nextjs
export NEXT_TEST_MODE=deploy
export NEXT_EXTERNAL_TESTS_FILTERS="$ADAPTER_DIR/test/deploy-tests-manifest.json"
export NEXT_TEST_DEPLOY_SCRIPT_PATH="$ADAPTER_DIR/scripts/e2e-deploy.sh"
export NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH="$ADAPTER_DIR/scripts/e2e-logs.sh"
export NEXT_TEST_CLEANUP_SCRIPT_PATH="$ADAPTER_DIR/scripts/e2e-cleanup.sh"
export IS_TURBOPACK_TEST=1 NEXT_TELEMETRY_DISABLED=1
# Not optional either. cdk-nextjs is an adapter deployment and ten e2e files ask,
# most of them as `skipDeployment: !isAdapterTest` - left unset they report a pass
# in ~5s having deployed nothing. The only other thing that reads it is the Vercel
# deploy path (a team and token), which a custom deploy script never reaches.
export NEXT_ENABLE_ADAPTER=1
# Not optional. next.js defaults this to 120s and `createNext` runs inside jest's
# `beforeAll`, so everything below is charged against it: isolating the fixture,
# `pnpm install`, `next build`, `cdk deploy` (~52s even when it hotswaps), and the
# CloudFront invalidation wait. Measured, that sums past 120s for most files, and
# a file over budget fails *wholesale* on every retry with `Exceeded timeout of
# 120000 ms for a hook` - which is indistinguishable from a real failure unless
# you read the elapsed time. CI uses this same value
# (.github/workflows/e2e-harness.yml).
export NEXT_E2E_TEST_TIMEOUT=240000
node run-tests.js --timings -c 1 --retries 1 --type e2e

# back in cdk-nextjs: the shared stack is still up by design. Look, then delete.
./scripts/e2e-sweep.sh --dry-run
./scripts/e2e-sweep.sh --apply --shared
```

To exercise just the deploy/logs/cleanup contract without the next.js suite,
point them at any built Next.js app:

```bash
cd /path/to/some/nextjs/app
ADAPTER_DIR=/path/to/cdk-nextjs /path/to/cdk-nextjs/scripts/e2e-deploy.sh
ADAPTER_DIR=/path/to/cdk-nextjs /path/to/cdk-nextjs/scripts/e2e-logs.sh
ADAPTER_DIR=/path/to/cdk-nextjs /path/to/cdk-nextjs/scripts/e2e-cleanup.sh
```

## Debugging one failing file without deploying

A deployed iteration costs 2–3 minutes and gives you a log. `e2e-offline.sh` costs
~90 seconds and gives you a server you can instrument:

```bash
scripts/e2e-offline.sh app-dir/layout-params   # then curl :3112 and :3113
```

It builds the fixture through the adapter and serves the same build twice — once
by our container shell, once by `next start` — so "why does the deployment
disagree with next.js" becomes one `diff` of two responses. Defects 11, 13 and 14
in `docs/harness-coverage.md` were all found this way; 11 in particular had
survived one wrong fix because the value in question only shows up under a
debugger (`JSON.stringify` erases it).

Two limits. The fixture is staged _inside_ the next.js checkout, because module
resolution has to walk up to its `node_modules/next` — the script handles that, but
it means the app directory is not in this repo and you should delete it when done.
And the runtime cache reads S3 only, so a route served entirely from a build-time
prerender answers `invariant: cache entry required but not generated` offline; for
those, read the seed directory (`.next/cdk-nextjs-init-cache`) instead of the
response, or deploy.

## The logs script's output _is_ `next.cliOutput`

Worth knowing before adding anything to `e2e-logs.sh`. In deploy mode next.js sets

```ts
this._cliOutput = await this.fetchBuildLogsUsingCustomScript();
```

(`test/lib/next-modes/next-deploy.ts`), so the script's stdout is not just what
gets printed when a deployment fails — it is the string every test that reads
`next.cliOutput` asserts against. Vercel's own deploy mode puts the **build** logs
there and nothing else.

That is why the deploy log and the CloudWatch tail are behind
`HARNESS_VERBOSE_LOGS=1`. `test/e2e/deprecation-warnings` asserts
`expect(next.cliOutput).not.toContain('deprecated')`, and it failed on

```
[WARNING] aws-cdk-lib.aws_dynamodb.TableGrantsProps#encryptedResource is deprecated.
```

which the CDK CLI printed during synth — aws-cdk-lib 2.261.0 emits it from inside
its own `TableV2` constructor, so no consumer can avoid it. Nothing about the app
under test was wrong; our diagnostics were being read as the app's output.

When a deployment does fail, set the flag and re-run the one file.

## Cleanup and safety

A CloudFront distribution that outlives its run is the thing to avoid, so there
are two layers:

1. `e2e-cleanup.sh` runs after every test file, pass or fail. In shared-stack
   mode it deliberately keeps the stack; under `HARNESS_ISOLATED_STACK=1` it
   calls `delete-stack` without waiting.
2. `e2e-sweep.sh` deletes the shared stack after a run, and any leftovers a
   cancelled or timed-out shard left behind.

Both refuse to delete a stack unless it is named `hrns-*` **and** tagged
`cdk-nextjs:harness=1`, re-checked immediately before the delete. The sweeper is
additionally a dry run unless given `--apply`, and ignores anything younger than
`HARNESS_SWEEP_MAX_AGE_HOURS` (default 6) so it can never delete a stack out from
under a run in progress. To delete a stack you just created, name it — `--shared`
or `--stack NAME`, which narrows the sweep to that one stack instead of lowering
the age floor for every stack in the account.

## Environment knobs

| Variable                            | Default                              | Effect                                                                                                 |
| ----------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `ADAPTER_DIR`                       | _required_                           | This checkout. All three scripts resolve everything from it.                                           |
| `CDK_BIN`                           | `$ADAPTER_DIR/node_modules/.bin/cdk` | CDK CLI to deploy with.                                                                                |
| `HARNESS_SUPPORTS_IMMUTABLE_ASSETS` | `0`                                  | The `NEXT_SUPPORTS_IMMUTABLE_ASSETS` marker. Flip to `1` with `docs/plans/immutable-static-assets.md`. |
| `HARNESS_NEXTJS_TYPE`               | `global-functions`                   | Or `regional-functions`: deploy `NextjsRegionalFunctions` behind `stage-proxy.mjs`, into `hrns-rf-*` stacks. See "Running on `NextjsRegionalFunctions`". |
| `HARNESS_PROXY_PORT`                | _derived from the stack name_        | Port `stage-proxy.mjs` listens on. Regional only.                                                      |
| `HARNESS_ISOLATED_STACK`            | `0`                                  | One stack per test file instead of one shared one. Re-enables `e2e-cleanup.sh`.                        |
| `HARNESS_SHARED_STACK_SUFFIX`       | `shared`                             | Shared stack name, after the `hrns-` prefix. One per shard, and per concurrent local suite.            |
| `HARNESS_CLEANUP_WAIT`              | `0`                                  | Block until the stack delete completes. Isolated mode only.                                            |
| `HARNESS_LOG_LINES`                 | `400`                                | Tail length per log section.                                                                           |
| `HARNESS_LOG_SINCE`                 | `30m`                                | CloudWatch window for the runtime log tail.                                                            |
| `HARNESS_VERBOSE_LOGS`              | `0`                                  | Add the deploy log and CloudWatch tail to `e2e-logs.sh`. Off by default because that output _is_ `next.cliOutput` — see below.                                                   |
| `HARNESS_SWEEP_MAX_AGE_HOURS`       | `6`                                  | Age floor for the sweeper. Ignored when a stack is named.                                              |
| `HARNESS_SWEEP_STACK`               | _unset_                              | Same as passing `--stack NAME`: sweep only that stack, at any age.                                     |
| `HARNESS_SWEEP_APPLY`               | `0`                                  | Same as passing `--apply`.                                                                             |
| `WARM_KEEP`                         | `0`                                  | Keep `e2e-warm.sh`'s throwaway app directory, whose deploy log says why warming failed.                |
| `NEXT_E2E_TEST_TIMEOUT`             | next.js's 120000                     | next.js's own knob, but effectively required here: the deploy runs inside `beforeAll`. Use `240000`.   |

[harness]: https://nextjs.org/docs/app/api-reference/adapters/testing-adapters
