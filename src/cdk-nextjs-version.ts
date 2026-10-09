/**
 * The installed cdk-nextjs version, stamped into the adapter manifest so that a
 * build written by one cdk-nextjs is never read by another.
 *
 * `require` rather than `import`: `package.json` is outside `rootDir`. The path
 * resolves to the package root from `src/` (tests), `lib/` (the compiled
 * constructs), and the esbuild bundles, which inline it. They're bundled after
 * the release task's `bump`, so they get the released version too.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const CDK_NEXTJS_VERSION: string = require("../package.json").version;
