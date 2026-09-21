#!/usr/bin/env node
/**
 * Copy `<distDir>/static` and `public/` into the adapter's staged deployment
 * tree, so the compute can serve them itself.
 *
 * The product deliberately does not stage those two directories
 * (`src/runtime/static-files.ts`): CloudFront and API Gateway route both
 * prefixes to the `NextjsStaticAssets` bucket, and a second copy inside the
 * function would be duplicated bytes plus a real risk of blowing Lambda's
 * 250 MB unzipped limit on a `public/` of any size.
 *
 * The harness cannot use that routing. It reports a Lambda Function URL as the
 * deployment URL - see the comment in `app.js` for why nothing with a path
 * prefix works - and a bare Function URL has no S3 integration in front of it,
 * so `/_next/static/*` would 404 and every page would load without its client
 * chunks. Copying the files in is the narrowest way to make the front door
 * complete; what it gives up is coverage of the S3 routing itself, which
 * `examples/e2e-tests` exercises on every commit.
 *
 * Runs between `next build` and `cdk deploy`, which is why it reads the
 * adapter's own `<distDir>/cdk-nextjs-adapter/manifest.json` and not the
 * per-entrypoint one: the entrypoint manifests (and the runtime shells next to
 * them) are written by synth, so they do not exist yet.
 *
 * Usage: `node stage-static.js <appDir>`
 *
 * @see scripts/e2e-harness/README.md
 */
const { cpSync, existsSync, readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const appDir = process.argv[2];
if (!appDir) {
  console.error("usage: node stage-static.js <appDir>");
  process.exit(1);
}

const stagingRoot = findStagingRoot(appDir);
const manifest = JSON.parse(
  readFileSync(join(stagingRoot, "manifest.json"), "utf8"),
);
const relativeProjectDir = manifest.relativeProjectDir ?? "";
const distDir = manifest.config?.distDir ?? ".next";

// One directory per entrypoint - a split build has several, and each is its own
// self-contained deployment root that needs its own copy.
const deploymentRoots = readdirSync(stagingRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(stagingRoot, entry.name));

let copied = 0;
for (const deploymentRoot of deploymentRoots) {
  // The paths in `manifest.staticFiles` are relative to the deployment root, so
  // the copies have to land at exactly the layout the manifest already claims.
  const projectDir = join(deploymentRoot, relativeProjectDir);
  copied += copyDir(
    join(appDir, relativeProjectDir, distDir, "static"),
    join(projectDir, distDir, "static"),
  );
  copied += copyDir(
    join(appDir, relativeProjectDir, "public"),
    join(projectDir, "public"),
  );
}

if (copied === 0) {
  // Not fatal on its own - an app can have neither directory - but it is the
  // failure mode behind "every test 404s on its chunks", so fail loudly rather
  // than deploy something that cannot pass.
  console.error(
    `harness: staged no static directories into ${stagingRoot}. Looked for ` +
      `"${join(relativeProjectDir, distDir, "static")}" and ` +
      `"${join(relativeProjectDir, "public")}" under ${appDir}, and found ` +
      `${deploymentRoots.length} entrypoint director${deploymentRoots.length === 1 ? "y" : "ies"}.`,
  );
  process.exit(1);
}

function findStagingRoot(dir) {
  for (const candidateDistDir of [".next", "dist", "build"]) {
    const candidate = join(dir, candidateDistDir, "cdk-nextjs-adapter");
    if (existsSync(join(candidate, "manifest.json"))) {
      return candidate;
    }
  }
  throw new Error(
    `harness: no cdk-nextjs-adapter staging directory under "${dir}". ` +
      `\`next build\` either did not run or did not run through the adapter.`,
  );
}

function copyDir(from, to) {
  if (!existsSync(from)) {
    return 0;
  }
  cpSync(from, to, { recursive: true, dereference: true });
  console.error(`harness: staged ${from} -> ${to}`);
  return 1;
}
