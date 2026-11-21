import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LAMBDA_RUNTIME } from "./lambda-runtime";

// The runtime's Node major is written in several places that nothing else ties
// together: `LAMBDA_RUNTIME`, `nodeVersion` in `.projenrc.ts` (the generated
// custom-resource functions and the runtime bundles' target), the generated
// Dockerfiles, the CI pins and the examples. This keeps them on one major.
// The build-time bundles target `minNodeVersion` instead, which is the synth
// floor, not the runtime.
const repoRoot = join(__dirname, "..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf-8");
const major = /^nodejs(\d+)\.x$/.exec(LAMBDA_RUNTIME.name)![1];
const floor = /^>= (\d+\.\d+\.\d+)$/.exec(
  JSON.parse(read("package.json")).engines.node,
)![1];

function matches(path: string, pattern: RegExp): string[] {
  return [...read(path).matchAll(pattern)].map((m) => m[1]);
}

test("the runtime major is a Node major", () => {
  expect(Number(major)).toBeGreaterThan(Number(floor.split(".")[0]));
});

test("the bundles target the runtime major or the synth floor", () => {
  const targets = matches(".projen/tasks.json", /"--target=node([\d.]+)"/g);
  expect(targets.length).toBeGreaterThan(0);
  expect(new Set(targets)).toEqual(new Set([major, floor]));
});

test.each([
  "src/lambdas/post-deploy/post-deploy-function.ts",
  "src/lambdas/redeploy-stage/redeploy-stage-function.ts",
  "examples/load-tests/stacks/app.ts",
  "examples/regional-functions/app.ts",
])("%s uses the runtime major", (path) => {
  const runtimes = matches(path, /nodejs(\d+)\.x/g);
  expect(runtimes.length).toBeGreaterThan(0);
  expect(new Set(runtimes)).toEqual(new Set([major]));
});

test.each([
  "src/nextjs-build/global-containers.Dockerfile",
  "src/nextjs-build/regional-containers.Dockerfile",
])("%s starts from the runtime major", (path) => {
  expect(matches(path, /^FROM \S*node:(\d+)-alpine/gm)).toEqual([major]);
});

test("the docs name the runtime major's container image", () => {
  for (const path of ["README.md", "docs/native-dependencies-guide.md"]) {
    const images = matches(path, /node:(\d+)-alpine/g);
    expect(images.length).toBeGreaterThan(0);
    expect(new Set(images)).toEqual(new Set([major]));
  }
});

// The Next.js compatibility harness runs next.js's own test tooling on the
// runner, which follows next.js's supported Node, not ours; its fixtures still
// deploy on `LAMBDA_RUNTIME`. Raise this when next.js's tooling runs on the
// runtime major (yargs 16 broke on Node 26).
const HARNESS_WORKFLOW = ".github/workflows/e2e-harness.yml";
const HARNESS_RUNNER_MAJOR = "24";

test("CI pins the runtime major", () => {
  // Projen's own workflows use `lts/*`; only hand-written numeric pins count.
  const files = [
    ...readdirSync(join(repoRoot, ".github/workflows")).map(
      (f) => `.github/workflows/${f}`,
    ),
    ...readdirSync(join(repoRoot, ".github/actions")).map(
      (d) => `.github/actions/${d}/action.yml`,
    ),
  ].filter((f) => /\.ya?ml$/.test(f) && f !== HARNESS_WORKFLOW);
  const pins = files.flatMap((f) => matches(f, /node-version: (\d+)\s*$/gm));
  expect(pins.length).toBeGreaterThan(0);
  expect(new Set(pins)).toEqual(new Set([major]));
});

test("the harness runner pins next.js's Node, cache key included", () => {
  expect(matches(HARNESS_WORKFLOW, /node-version: (\d+)\s*$/gm)).toEqual([
    HARNESS_RUNNER_MAJOR,
    HARNESS_RUNNER_MAJOR,
  ]);
  expect(matches(HARNESS_WORKFLOW, /ubuntu-[\d.]+-node(\d+)-/g)).toEqual([
    HARNESS_RUNNER_MAJOR,
  ]);
});

test("the load-test runner installs the runtime major", () => {
  expect(
    matches("examples/load-tests/runner/app.ts", /--channel=(\d+)"/g),
  ).toEqual([major]);
});
