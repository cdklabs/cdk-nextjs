/**
 * Resolving the handful of `next` internals the runtime itself needs, out of the
 * staged app rather than from next to the shell.
 *
 * `next` is deliberately external to both shell bundles: the deployment already
 * carries the traced `next` files every built entrypoint requires, and a second
 * bundled copy would be a different module instance — pinned to *cdk-nextjs's*
 * `next` version rather than the consumer's.
 *
 * Marking it external is not enough on its own. esbuild turns
 * `import { serveStatic } from "next/dist/server/serve-static.js"` into a real,
 * hoisted `import` inside `cdk-nextjs-runtime/lambda.mjs`, which Node resolves by
 * walking `cdk-nextjs-runtime/node_modules` and then `<deploymentRoot>/node_modules`
 * — and under pnpm neither holds `next`. The only `next` in the staged tree is the
 * relative symlink at `<projectDir>/node_modules/next` that the traced entrypoints
 * resolve through, one directory *below* the deployment root. A hoisted npm/yarn
 * monorepo puts it somewhere else again. Since those imports are hoisted, getting
 * this wrong is not a degraded image route: the shell fails to load at all.
 *
 * So every such module is required through a `createRequire` anchored inside the
 * staged project dir, which makes the runtime resolve `next` by the same walk the
 * entrypoints do, for any package manager and any layout. That also means they
 * cannot be imported at module scope; each caller resolves (and memoizes) on
 * first use, after {@link useNextFrom}.
 */
import { createRequire } from "node:module";
import { join } from "node:path";

let nextRequire: ReturnType<typeof createRequire> | undefined;

/**
 * Point `next` resolution at the staged Next.js project. Called once by
 * `loadRuntime`, before anything can serve a request.
 *
 * @param projectDir absolute path to the staged project dir
 * (`join(deploymentRoot, manifest.relativeProjectDir)`).
 */
export function useNextFrom(projectDir: string): void {
  // Anchored on a path *inside* `projectDir`, because `createRequire` starts its
  // `node_modules` walk at the anchor's directory. The file needn't exist.
  nextRequire = createRequire(join(projectDir, "cdk-nextjs-next-resolver.cjs"));
}

/**
 * `require` a `next` submodule from the staged app.
 *
 * Pass the module's own type — `nextModule<typeof import("next/dist/...")>(...)` —
 * so the call is as type-checked as a static import would be.
 */
export function nextModule<T>(specifier: string): T {
  if (!nextRequire) {
    throw new Error(
      `Cannot load "${specifier}": \`next\` resolution has not been pointed at ` +
        `the staged app yet. \`useNextFrom\` runs in \`loadRuntime\`, so this ` +
        `means runtime code loaded a \`next\` module before the runtime was ` +
        `loaded.`,
    );
  }
  try {
    return nextRequire(specifier) as T;
  } catch (cause) {
    throw new Error(
      `Could not resolve "${specifier}" from the deployed Next.js project. The ` +
        `deployment package is missing part of the \`next\` closure that ` +
        `\`next build\` traced, or \`node_modules/next\` resolves to a symlink ` +
        `target that was not staged.`,
      { cause },
    );
  }
}
