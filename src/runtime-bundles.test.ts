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
  return (
    Object.entries(tasks)
      .filter(
        ([name]) => name.startsWith("bundle:") && !name.endsWith(":watch"),
      )
      .flatMap(([name, task]) =>
        (task.steps ?? []).map((step) => [name, step.exec ?? ""] as const),
      )
      // Skip only what is plainly a browser bundle, so a change in how projen
      // writes its flags can't drop a node bundle from the check unseen.
      .filter(
        ([, exec]) =>
          exec.startsWith("esbuild ") &&
          !/--platform[= ]"?browser\b/.test(exec),
      )
      .map(([name, exec]): [string, BundleTask] => {
        const entry = /--bundle "?([^\s"]+)/.exec(exec)?.[1];
        if (!entry) throw new Error(`${name}: no --bundle entry in ${exec}`);
        return [
          name,
          {
            entry,
            // esbuild bundles for node as CommonJS unless told otherwise.
            format: /--format[= ]"?esm\b/.test(exec) ? "esm" : "cjs",
            external: [...exec.matchAll(/--external:"?([^\s"]+)/g)].map(
              (m) => m[1],
            ),
            tsconfig: /--tsconfig[= ]"?([^\s"]+)/.exec(exec)?.[1],
          },
        ];
      })
  );
}

const bundles = nodeBundleTasks();

test("finds every node bundle task", () => {
  const names = bundles.map(([name]) => name);
  // The adapter, its three cache handlers, the two runtime shells and the two
  // custom-resource handlers.
  expect(names.length).toBeGreaterThanOrEqual(8);
  expect(names).toEqual(
    expect.arrayContaining([
      "bundle:adapter/adapter",
      "bundle:adapter/cache-handler",
      "bundle:runtime/lambda",
      "bundle:runtime/server",
      "bundle:lambdas/post-deploy/post-deploy.lambda",
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
