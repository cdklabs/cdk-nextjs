# cdk-nextjs Load Tests

[k6](https://grafana.com/docs/k6/latest/) load tests behind the README's
[Performance](../../README.md#performance) section. They compare the four root
constructs with each other, using the same app, the same sizing and the same
load.

## What's measured

Every run targets [`examples/bench-app`](../bench-app), a small Next.js app
built for this. It makes no calls outside the stack under test: loading a route
that fetches from a public API would load test that API and put its latency in
our numbers.

| Kind           | Request                               | Answered by                                                            |
| -------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `static-asset` | a `/_next/static` JS chunk            | CloudFront/S3 (Global), API Gateway/S3 or the container (Regional)     |
| `static`       | `/static`, prerendered                | CloudFront cache (Global), compute (Regional)                          |
| `isr`          | `/isr`, `revalidate = 10`             | CloudFront cache until stale, then compute and the S3 + DynamoDB cache |
| `ssr`          | `/ssr`, `connection()`                | compute, every request                                                 |
| `stream`       | `/stream`, 200 ms in-process Suspense | compute, every request; TTFB is the shell                              |
| `rsc`          | `/ssr` RSC payload (`RSC: 1`)         | compute, every request                                                 |
| `api`          | `/api/dynamic` route handler          | compute, every request                                                 |
| `image`        | `/_next/image` of a local 800 px JPEG | CloudFront cache (Global), image optimization (Regional)               |

Every response is counted by its `x-cache` header, so the results show whether
a number is CloudFront's or the construct's.

| Script            | What it answers                                                                                                                                                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm latency`    | p50/p95/p99 per kind at fixed request rates (`RATES`, default `10,50` req/s per kind, `STEP_SECONDS` (180) each, all kinds at once, so the total is 8× the rate). A 30 s warm-up runs first and isn't reported. The Functions constructs are worth running at `RATES=10,50,250,1000` too. |
| `pnpm capacity`   | The highest rate one kind (`KIND`, default `ssr`) sustains. Steps up by `FACTOR` (1.5) every `STEP_SECONDS` (60) from `START_RATE` (50) to `MAX_RATE` (8000), and aborts once a step is clearly broken.                                                                                   |
| `pnpm cold-start` | Functions constructs only. Forces fresh Lambda execution environments, then measures `CONCURRENCY` (10) simultaneous first requests, `ROUNDS` (5) times.                                                                                                                                  |
| `pnpm browser`    | Web Vitals (LCP, FCP, CLS, TTFB) and client-side navigation time from real Chromium visitors. For vitals under load, run it from a second machine while `pnpm latency` runs on the first, with `UNDER_LOAD="50 req/s per route"` (or whatever the load is) so the report says so.         |
| `pnpm report`     | Turns `results/` into the README's markdown tables.                                                                                                                                                                                                                                       |

Results go to `results/<LABEL>/<script>-<time>.json`, where `LABEL` is the
construct, e.g. `global-functions`.

## Running

1. Create `.env`:

   ```sh
   AWS_PROFILE=<profile>
   AWS_REGION=us-east-1
   CONSTRUCT=global-functions             # which stack stack:deploy deploys
   BASE_URL=https://d123.cloudfront.net   # its URL, with /prod on NextjsRegionalFunctions
   LABEL=global-functions
   STACK=perf-glbl-fns                    # cold-start only
   COOKIE=cdk-nextjs=1                    # NextjsRegionalContainers only
   ```

2. Deploy the construct's stack from [`stacks/app.ts`](./stacks/app.ts), which
   deploys the bench app with the construct's defaults, except that the
   Containers constructs scale on CPU from 2 to 10 tasks (`PERF_MIN_TASKS`,
   `PERF_MAX_TASKS`) and nothing logs every request:

   ```sh
   pnpm stack:deploy    # URL in stack-outputs.json; pnpm stack:destroy when done
   ```

   Stacks are named `perf-*`, which the EC2 runner's permissions match. Each
   synth builds `bench-app`, so deploy one construct at a time from a checkout.

3. Run the tests:

   ```sh
   pnpm latency
   pnpm capacity                   # KIND=isr pnpm capacity, etc.
   pnpm cold-start                 # Functions constructs
   pnpm browser
   pnpm report
   ```

   Everything is an env var, e.g. `RATES=10 STEP_SECONDS=20 pnpm latency` for a
   quick check. Extra arguments go to `k6 run`.

### From EC2 (for published numbers)

A home connection caps the load (1 Gbps is only a few thousand page loads a
second) and adds jitter to every percentile. `runner/app.ts` is `c7g.2xlarge`
instances in us-east-1 (`-c instanceType=...`, `-c count=N` for one per
stack, `-c availabilityZone=...` when a zone is out of the type). They have no
inbound ports; connect with SSM Session Manager. One sustains about 8,000 req/s
of small responses.

```sh
pnpm runner:deploy                    # instance IDs are in runner-outputs.json
aws ssm start-session --target <instance id> \
  --document-name AWS-StartInteractiveCommand --parameters command="bash -l"
# on the instance
cd /opt/load-tests
BASE_URL=... LABEL=... bash scripts/k6.sh latency
STACK=... BASE_URL=... LABEL=... node scripts/cold-start.ts
aws s3 sync results "s3://$RESULTS_BUCKET/results"
# back on your machine
aws s3 sync s3://<ResultsBucket>/results results && pnpm report
pnpm runner:destroy
```

The instance role can list and reconfigure only `perf-*` stacks' functions,
for `cold-start`. Changing anything in this directory replaces the instances on
the next `runner:deploy`.

## Reading the numbers

- On the Global constructs, the load generator reaches the CloudFront edge
  location nearest it. From EC2 in us-east-1 that is one edge location near
  the origin, so the numbers show origin performance plus a short hop, not
  latency from around the world.
- A new container task takes 2–4 minutes to serve, so run container capacity
  tests with `STEP_SECONDS=240` or more, or the steps outrun the scaling. Two
  1 vCPU tasks serve well under 200 req/s of SSR, so start them low
  (`START_RATE=25`). Functions run 2048 MB Lambda functions and scale out to
  the account's concurrency limit.
- Past their capacity, the Containers constructs don't degrade gradually:
  tasks too busy to answer the ALB health check in time get replaced, which
  leaves fewer tasks for the same load and resets the CPU average autoscaling
  tracks. Leave health-check headroom when sizing them.
- NextjsRegionalFunctions sits behind API Gateway, whose default account
  throttle (10,000 req/s, burst 5,000) can cap capacity before Lambda does,
  and is shared by every API in the account and region.
- A `dropped` count well above 0 means k6 ran out of VUs to keep the rate, so
  the target was slower than the rate allows. Treat that step as failed.
  A load generator given far more VUs than it needs slows itself down too,
  which is why the scripts allocate about one per 10 req/s.
- AWS allows load testing your own resources, but read the
  [simulated events policy](https://aws.amazon.com/security/ddos-simulation-testing/)
  before going well beyond these rates.
