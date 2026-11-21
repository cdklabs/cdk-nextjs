/* eslint-disable import/no-extraneous-dependencies */
import { join } from "node:path";
import { buildSync } from "esbuild";

// The adapter, cache handlers and runtime ship to Lambda, the containers and
// the user's own `next build`. A module-scope CDK object in a file they import
// (`constants.ts`, say) drags all of `aws-cdk-lib` in with it: ~10 MB each.
const repoRoot = join(__dirname, "..");
const entries = [
  "src/adapter/adapter.mts",
  "src/adapter/cache-handler.ts",
  "src/adapter/use-cache-default-handler.ts",
  "src/adapter/use-cache-remote-handler.ts",
  "src/runtime/lambda.mts",
  "src/runtime/server.mts",
];

test.each(entries)("%s bundles without aws-cdk-lib or constructs", (entry) => {
  const { metafile } = buildSync({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["next", "sharp", "@opentelemetry/api"],
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
});
