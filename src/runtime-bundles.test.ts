/* eslint-disable import/no-extraneous-dependencies */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSync } from "esbuild";

// The adapter, cache handlers, runtime and custom-resource handlers ship to
// Lambda, the containers and the user's own `next build`. A module-scope CDK
// object in a file they import (`constants.ts`, say) drags all of
// `aws-cdk-lib` in with it: ~10 MB each. Each bundle is rebuilt here from its
// own `bundle:*` task, so the entry, format, externals and tsconfig are the
// ones that ship.
const repoRoot = join(__dirname, "..");

interface BundleTask {
  readonly entry: string;
  readonly format: "esm" | "cjs";
  readonly external: string[];
  readonly tsconfig?: string;
}

function nodeBundleTasks(): [string, BundleTask][] {
  const { tasks } = JSON.parse(
    readFileSync(join(repoRoot, ".projen", "tasks.json"), "utf-8"),
  ) as { tasks: Record<string, { steps?: { exec?: string }[] }> };
  return Object.entries(tasks)
    .filter(([name]) => name.startsWith("bundle:") && !name.endsWith(":watch"))
    .flatMap(([name, task]) =>
      (task.steps ?? []).map((step) => [name, step.exec ?? ""] as const),
    )
    .filter(([, exec]) => exec.includes('--platform="node"'))
    .map(([name, exec]) => [
      name,
      {
        entry: /--bundle (\S+)/.exec(exec)![1],
        // esbuild bundles for node as CommonJS unless told otherwise.
        format: /--format=esm\b/.test(exec) ? "esm" : "cjs",
        external: [...exec.matchAll(/--external:(\S+)/g)].map((m) => m[1]),
        tsconfig: /--tsconfig="([^"]+)"/.exec(exec)?.[1],
      },
    ]);
}

const bundles = nodeBundleTasks();

test("finds the node bundle tasks", () => {
  expect(bundles.map(([name]) => name)).toEqual(
    expect.arrayContaining([
      "bundle:adapter/cache-handler",
      "bundle:runtime/lambda",
    ]),
  );
});

test.each(bundles)(
  "%s bundles without aws-cdk-lib or constructs",
  (_, task) => {
    const { metafile } = buildSync({
      absWorkingDir: repoRoot,
      entryPoints: [task.entry],
      bundle: true,
      platform: "node",
      format: task.format,
      external: task.external,
      tsconfig: task.tsconfig,
      metafile: true,
      write: false,
      logLevel: "silent",
    });
    const cdkInputs = Object.keys(metafile.inputs).filter((input) =>
      /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(aws-cdk-lib|constructs)\//.test(
        input,
      ),
    );
    expect(cdkInputs).toEqual([]);
  },
);
