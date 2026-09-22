# Next.js compatibility harness

Runs [vercel/next.js's own e2e suite][harness] against a real cdk-nextjs
deployment. It is a better correctness signal than any fixture app we would
write, because the tests were written by the people who define the behavior.

`examples/e2e-tests/` remains the per-commit gate on all four `NextjsType`s. This
is the nightly one, on `NextjsGlobalFunctions` only.

## Pieces

| Path                                | Role                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `scripts/e2e-deploy.sh`             | `NEXT_TEST_DEPLOY_SCRIPT_PATH`. Installs, builds through the adapter, deploys, invalidates, prints the URL.        |
| `scripts/e2e-logs.sh`               | `NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH`. Replays the build markers and logs, plus the Lambda's CloudWatch tail.        |
| `scripts/e2e-cleanup.sh`            | `NEXT_TEST_CLEANUP_SCRIPT_PATH`. A no-op in shared-stack mode; deletes the stack under `HARNESS_ISOLATED_STACK=1`. |
| `scripts/e2e-warm.sh`               | Creates the shared stack before the suite starts, so no test file pays for it. Run it first.                       |
| `scripts/e2e-sweep.sh`              | Deletes orphaned harness stacks, and the shared one after a run. Dry run unless `--apply`.                         |
| `scripts/e2e-harness/app.js`        | The CDK app the deploy script deploys.                                                                             |
| `scripts/e2e-harness/common.sh`     | Shared file names, stack naming, output reads, and the tag check that gates every delete.                          |
| `test/deploy-tests-manifest.json`   | Which next.js test files run (`NEXT_EXTERNAL_TESTS_FILTERS`).                                                      |
| `.github/workflows/e2e-harness.yml` | Nightly + `workflow_dispatch`.                                                                                     |

## One shared stack for the whole run

The harness creates an isolated app per test file and runs the deploy script with
`cwd` set to it, so there is no way to deploy once and point the whole suite at
one deployment — every file genuinely has different code to ship. What there is a
way to do is ship it into infrastructure that already exists.

Every test file deploys into the same stack (`hrns-shared`) with
`cdk deploy --hotswap-fallback`. Creating and propagating the CloudFront
distribution costs ~4 minutes once per run; every test file reuses it. That is
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
| `Custom::CDKBucketDeployment`   | `SourceObjectKeys`, key prefix      | yes          |
| `Custom::CDKBucketDeployment`   | `SourceObjectKeys`, `UserMetadata`  | yes          |
| `AWS::S3::Bucket`               | `Tags`                              | **no**       |
| `AWS::CloudFront::Distribution` | `DistributionConfig.CacheBehaviors` | **no**       |

So the honest expectation is that most test files take the CloudFormation
fallback, not the hotswap path:

- The cache bucket's `Tags` change because CDK stamps an
  `aws-cdk:cr-owned:<destinationKeyPrefix>:<hash>` tag on a `BucketDeployment`'s
  destination bucket, unconditionally, and `src/nextjs-cache.ts` uses the build ID
  as that prefix. Any fixture with prerendered content therefore has a
  non-hotswappable diff. (A fixture with no `.next/cdk-nextjs-init-cache` has no
  init-cache deployment at all, and does hotswap.)
- The distribution's cache behaviors change when a fixture's `public/` directory
  differs from the previous one's, since `public/` entries become behaviors
  (`src/nextjs-distribution.ts`). That is the expensive one — CloudFront has to
  propagate.

A CloudFormation update that leaves the distribution alone still costs only a
couple of minutes, against ~4 for a stack of its own plus a slow delete, so the
shared stack is worth it either way. `--hotswap-fallback` is kept because it is
free and takes the fast path when it can.

What the shared stack is paid for in:

- **Test files must be serialized** (`run-tests.js -c 1`). Two concurrent deploys
  into one stack would race.
- **`e2e-cleanup.sh` must not delete the stack**, or the next file pays the
  create again. It doesn't; `e2e-sweep.sh --apply` with
  `HARNESS_SWEEP_MAX_AGE_HOURS=0` deletes it once, after the run. The workflow
  does this in an `always()` step; a local run has to do it by hand.
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
taking next.js's `test/e2e/**` include rule, and this still runs nightly rather
than per-commit. Widen either deliberately - and only with files you have watched
pass, since a file can be unbuildable rather than merely failing (see below).

`HARNESS_ISOLATED_STACK=1` gives a stack per app directory instead — worth it to
debug a single file, or to run two things at once, at the cost of a distribution
create and delete per file.

## Why `NextjsGlobalFunctions`

The harness builds every request URL as `new URL(path, deploymentUrl)` —
`getFullUrl` in `test/lib/next-test-utils.ts` assigns `pathname` outright — so any
prefix in the deployment URL is dropped. That rules out both Regional types:
their API Gateway REST URL is always
`https://<id>.execute-api.<region>.amazonaws.com/<stage>`, and every absolute
path the suite requests would miss the stage and 404. A CloudFront distribution
is served at the origin root.

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
- `NextjsGlobalContainers` and both Regional types are not covered here at all.
  `examples/e2e-tests` is the gate on those.

## Which test files can run at all

cdk-nextjs rejects any build output whose runtime is not `nodejs`
(`assertNodeRuntimes` in `src/adapter/build-outputs.ts`), and it throws during
`next build`. So a fixture containing even one edge route, or a legacy edge
`middleware.ts`, does not fail some tests - it fails to build, and no per-case
`failed` entry in the manifest can rescue it. Such files have to stay out of
`rules.include`.

That is a product limitation and a deliberate one: the edge runtime is deprecated
in Next.js, and cdk-nextjs supports Next.js 16's Node-runtime `proxy.ts` instead.
Around 522 of next.js's e2e files are edge-free, so it barely constrains
widening the list. To check a candidate before adding it:

```bash
# in the next.js checkout, against the fixture root (usually the test file's dir
# or its parent)
find <fixture> -name "middleware.*"
grep -rl 'runtime = .edge.' <fixture>
```

Mind the "or its parent": for a `test/e2e/<name>/test/index.test.ts` the fixture
lives a directory *above* the test file, and screening only the test file's own
directory quietly misses its `middleware.js`.

Three more screens are worth running before spending a deploy on a candidate, all
against the test file rather than the fixture:

- `describe.skip` / `(isNextDev ? describe : describe.skip)` — a file skipped
  upstream reports as passing in a few seconds without deploying anything, and
  adding it to `rules.include` claims coverage that does not exist.
- `isNextDeploy` — usually next.js itself gating out what cannot work behind a
  CDN. Not always disqualifying, but read the gate before adding the file.
- `output: 'export'` in the fixture — a static export is not what any
  `NextjsType` deploys.

`excluded-notes` in the manifest records every file left out and why.

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
node run-tests.js --timings -c 1 --type e2e

# back in cdk-nextjs: the shared stack is still up by design. Look, then delete.
./scripts/e2e-sweep.sh --dry-run
HARNESS_SWEEP_MAX_AGE_HOURS=0 ./scripts/e2e-sweep.sh --apply
```

To exercise just the deploy/logs/cleanup contract without the next.js suite,
point them at any built Next.js app:

```bash
cd /path/to/some/nextjs/app
ADAPTER_DIR=/path/to/cdk-nextjs /path/to/cdk-nextjs/scripts/e2e-deploy.sh
ADAPTER_DIR=/path/to/cdk-nextjs /path/to/cdk-nextjs/scripts/e2e-logs.sh
ADAPTER_DIR=/path/to/cdk-nextjs /path/to/cdk-nextjs/scripts/e2e-cleanup.sh
```

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
under a run in progress.

## Environment knobs

| Variable                            | Default                              | Effect                                                                                                 |
| ----------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `ADAPTER_DIR`                       | _required_                           | This checkout. All three scripts resolve everything from it.                                           |
| `CDK_BIN`                           | `$ADAPTER_DIR/node_modules/.bin/cdk` | CDK CLI to deploy with.                                                                                |
| `HARNESS_SUPPORTS_IMMUTABLE_ASSETS` | `0`                                  | The `NEXT_SUPPORTS_IMMUTABLE_ASSETS` marker. Flip to `1` with `docs/plans/immutable-static-assets.md`. |
| `HARNESS_ISOLATED_STACK`            | `0`                                  | One stack per test file instead of one shared one. Re-enables `e2e-cleanup.sh`.                        |
| `HARNESS_SHARED_STACK_SUFFIX`       | `shared`                             | Shared stack name, after the `hrns-` prefix. Change it to run two suites at once.                      |
| `HARNESS_CLEANUP_WAIT`              | `0`                                  | Block until the stack delete completes. Isolated mode only.                                            |
| `HARNESS_LOG_LINES`                 | `400`                                | Tail length per log section.                                                                           |
| `HARNESS_LOG_SINCE`                 | `30m`                                | CloudWatch window for the runtime log tail.                                                            |
| `HARNESS_SWEEP_MAX_AGE_HOURS`       | `6`                                  | Age floor for the sweeper.                                                                             |
| `HARNESS_SWEEP_APPLY`               | `0`                                  | Same as passing `--apply`.                                                                             |
| `WARM_KEEP`                         | `0`                                  | Keep `e2e-warm.sh`'s throwaway app directory, whose deploy log says why warming failed.                |

[harness]: https://nextjs.org/docs/app/api-reference/adapters/testing-adapters
