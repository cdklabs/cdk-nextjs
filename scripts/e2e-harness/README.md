# Next.js compatibility harness

Runs [vercel/next.js's own e2e suite][harness] against a real cdk-nextjs
deployment. It is a better correctness signal than any fixture app we would
write, because the tests were written by the people who define the behavior.

`examples/e2e-tests/` remains the per-commit gate on all four `NextjsType`s. This
is the nightly one, on `NextjsRegionalFunctions` only.

## Pieces

| Path                            | Role                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `scripts/e2e-deploy.sh`         | `NEXT_TEST_DEPLOY_SCRIPT_PATH`. Installs, builds through the adapter, deploys a stack, prints the URL. |
| `scripts/e2e-logs.sh`           | `NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH`. Replays the build markers and logs, plus the Lambda's CloudWatch tail. |
| `scripts/e2e-cleanup.sh`        | `NEXT_TEST_CLEANUP_SCRIPT_PATH`. Deletes that stack.                                |
| `scripts/e2e-sweep.sh`          | Deletes orphaned harness stacks. Dry run unless `--apply`.                           |
| `scripts/e2e-harness/app.js`    | The CDK app the deploy script deploys.                                              |
| `scripts/e2e-harness/common.sh` | Shared file names, stack naming, and the tag check that gates every delete.          |
| `scripts/e2e-harness/stage-static.js` | Copies `_next/static` and `public/` into the deployment package, which a Function URL front door needs. |
| `test/deploy-tests-manifest.json` | Which next.js test files run (`NEXT_EXTERNAL_TESTS_FILTERS`).                      |
| `.github/workflows/e2e-harness.yml` | Nightly + `workflow_dispatch`.                                                  |

## Why one stack per test file

The harness creates an isolated app per test file and runs the deploy script with
`cwd` set to it. There is no way to deploy once and point the suite at it, so a
run costs **one CDK deploy per test file** — which is why:

- It runs against `NextjsRegionalFunctions` (zip Lambda, ~3–4 minutes a deploy)
  and not the Global types, where a CloudFront distribution adds 5–15 minutes to
  create and again to delete, and hundreds of distributions would hit account
  quotas.
- `test/deploy-tests-manifest.json` lists files explicitly instead of taking
  next.js's `test/e2e/**` include rule. Widen it deliberately.
- It is nightly and `workflow_dispatch`, not per-commit.

## Why the deployment URL is a Function URL

The harness builds every request URL as `new URL(path, deploymentUrl)` —
`getFullUrl` in `test/lib/next-test-utils.ts` assigns `pathname` outright. Any
prefix in the deployment URL is therefore dropped, and an API Gateway REST API
URL is always `https://<id>.execute-api.<region>.amazonaws.com/<stage>`. So the
stage-prefixed URL that `examples/regional-functions` uses (with a matching
`basePath`) cannot be handed to this harness: every absolute path would miss the
stage and 404.

`app.js` adds a Function URL to the same server Lambda and reports that instead.
Same function, same adapter output, same `src/runtime` entrypoint; only the front
door differs. The stack still contains the API Gateway, and its URL is reported
as the `ApiUrl` output for debugging by hand.

That costs one thing. `_next/static` and `public/` are the two prefixes the
product routes to the `NextjsStaticAssets` bucket instead of to the compute, and
so the adapter deliberately leaves them out of the deployment package
(`src/runtime/static-files.ts`). A bare Function URL has no S3 integration in
front of it, so those requests arrive at the function with nothing on disk to
answer them — every page would load without its client chunks.

`scripts/e2e-harness/stage-static.js` copies both directories into the staged
tree after the build, at the layout `manifest.staticFiles` already claims, so the
function can serve them. **What the harness therefore does not cover:** the S3
routing itself. `examples/e2e-tests` exercises that on every commit, on all four
types.

## Running it locally

Needs a next.js checkout at the tag matching this repo's `next` version, built
once (`pnpm install && pnpm build && pnpm install` in it — `run-tests.js` and
`test/lib` are repo files, not published ones), and AWS credentials that can
deploy.

```bash
# in the cdk-nextjs checkout
pnpm i && pnpm bundle && pnpm compile

# in the next.js checkout
export ADAPTER_DIR=/path/to/cdk-nextjs
export NEXT_TEST_MODE=deploy
export NEXT_EXTERNAL_TESTS_FILTERS="$ADAPTER_DIR/test/deploy-tests-manifest.json"
export NEXT_TEST_DEPLOY_SCRIPT_PATH="$ADAPTER_DIR/scripts/e2e-deploy.sh"
export NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH="$ADAPTER_DIR/scripts/e2e-logs.sh"
export NEXT_TEST_CLEANUP_SCRIPT_PATH="$ADAPTER_DIR/scripts/e2e-cleanup.sh"
export IS_TURBOPACK_TEST=1 NEXT_TELEMETRY_DISABLED=1
node run-tests.js --timings -c 1 --type e2e

# back in cdk-nextjs, confirm nothing leaked
./scripts/e2e-sweep.sh
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

One stack per test file means a cleanup that quietly does nothing leaks dozens of
stacks per run, so there are two layers:

1. `e2e-cleanup.sh` runs after every test file, pass or fail, and calls
   `delete-stack` without waiting.
2. `e2e-sweep.sh` deletes leftovers — the cases a cancelled or timed-out shard
   leaves behind.

Both refuse to delete a stack unless it is named `hrns-*` **and** tagged
`cdk-nextjs:harness=1`, re-checked immediately before the delete. The sweeper is
additionally a dry run unless given `--apply`, and ignores anything younger than
`HARNESS_SWEEP_MAX_AGE_HOURS` (default 6) so it can never delete a stack out from
under a run in progress.

## Environment knobs

| Variable                          | Default              | Effect                                                    |
| --------------------------------- | -------------------- | --------------------------------------------------------- |
| `ADAPTER_DIR`                     | _required_           | This checkout. All three scripts resolve everything from it. |
| `CDK_BIN`                         | `$ADAPTER_DIR/node_modules/.bin/cdk` | CDK CLI to deploy with.                   |
| `HARNESS_SUPPORTS_IMMUTABLE_ASSETS` | `0`                | The `NEXT_SUPPORTS_IMMUTABLE_ASSETS` marker. Flip to `1` with `docs/plans/immutable-static-assets.md`. |
| `HARNESS_CLEANUP_WAIT`            | `0`                  | Block until the stack delete completes.                   |
| `HARNESS_LOG_LINES`               | `400`                | Tail length per log section.                              |
| `HARNESS_LOG_SINCE`               | `30m`                | CloudWatch window for the runtime log tail.               |
| `HARNESS_SWEEP_MAX_AGE_HOURS`     | `6`                  | Age floor for the sweeper.                                |
| `HARNESS_SWEEP_APPLY`             | `0`                  | Same as passing `--apply`.                                |

[harness]: https://nextjs.org/docs/app/api-reference/adapters/testing-adapters
