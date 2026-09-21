/**
 * The build-time → run-time contract for the adapter runtime.
 *
 * `src/adapter/build-outputs.ts` writes an {@link AdapterManifest} during
 * `next build`; the runtime shells in `src/runtime/` read it at cold start and
 * the CDK constructs read it at synth. It is the only thing that crosses those
 * three boundaries, so it is deliberately plain JSON.
 *
 * **Every path in this manifest is a repo-root-relative POSIX key**, never a
 * build-machine absolute path: absolute paths work on the build machine and
 * fail in Lambda. The staging tree those keys index into is
 * `<distDir>/cdk-nextjs-adapter/app`, and at runtime `process.cwd()` is the
 * root of that tree.
 *
 * This file is intentionally not exported from `src/index.ts`: it is an
 * internal contract, not public construct API, so it is exempt from the JSII
 * restrictions the rest of `src/` follows.
 */

/** Current {@link AdapterManifest.version}. Bump on any breaking shape change. */
export const ADAPTER_MANIFEST_VERSION = 1;

/**
 * Directory written inside `distDir` (`.next`), matching the existing
 * `cdk-nextjs-init-cache` convention.
 */
export const ADAPTER_DIR_NAME = "cdk-nextjs-adapter";

/**
 * Deployment root inside {@link ADAPTER_DIR_NAME}: the staged union of every
 * shipped output's traced `assets`, keyed by repo-root-relative path. This is
 * what replaces `output: "standalone"`.
 */
export const STAGING_DIR_NAME = "app";

/** {@link AdapterManifest}, written inside {@link ADAPTER_DIR_NAME}. */
export const MANIFEST_FILE_NAME = "manifest.json";

/**
 * Reserved key inside the staging tree that cdk-nextjs's own bundled runtime
 * files are copied to at synth (Lambda handler
 * `cdk-nextjs-runtime/lambda.handler`). Reserved because a repo-root-relative
 * asset key could otherwise collide with it.
 */
export const RUNTIME_DIR_NAME = "cdk-nextjs-runtime";

export interface AdapterManifest {
  readonly version: 1;
  readonly buildId: string;
  /**
   * From `process.cwd()` (= staging root) to the Next.js project dir. Passed as
   * `requestMeta.relativeProjectDir`. "" when the app is at the repo root.
   */
  readonly relativeProjectDir: string;
  readonly config: AdapterManifestConfig;
  /** `ctx.routing` verbatim, including `middlewareMatchers`. */
  readonly routing: unknown;
  /** pages + pagesApi + appPages + appRoutes + staticFiles pathnames. */
  readonly pathnames: string[];
  /** Route *template* (`/blog/[slug]`) → entrypoint. */
  readonly entrypoints: Record<string, AdapterEntrypoint>;
  readonly middleware: AdapterMiddleware | null;
  readonly staticFiles: string[];
  /** Step 5 only: group name → route templates. Absent when not splitting. */
  readonly groups?: Record<string, string[]>;
}

export interface AdapterManifestConfig {
  readonly basePath: string;
  readonly trailingSlash: boolean;
  readonly assetPrefix: string;
  /**
   * `ResolveRoutesParams["i18n"]`-shaped, narrower than NextConfigComplete.
   * `null` when the app configures no `i18n`.
   */
  readonly i18n: unknown | null;
}

export type AdapterEntrypointType =
  "app-page" | "app-route" | "page" | "page-api";

export interface AdapterEntrypoint {
  readonly id: string;
  /** Repo-root-relative POSIX key inside the staging tree. Never absolute. */
  readonly filePath: string;
  readonly type: AdapterEntrypointType;
}

export interface AdapterMiddleware {
  readonly id: string;
  /** Repo-root-relative POSIX key inside the staging tree. Never absolute. */
  readonly filePath: string;
  readonly env: Record<string, string>;
}
