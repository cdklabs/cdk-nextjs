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
 * `<distDir>/cdk-nextjs-adapter/app`; the runtime calls that directory the
 * *deployment root* and resolves every key against it.
 *
 * This file is intentionally not exported from `src/index.ts`: it is an
 * internal contract, not public construct API, so it is exempt from the JSII
 * restrictions the rest of `src/` follows.
 */
import { join } from "node:path";

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

/**
 * Parent of the per-group deployment roots, used instead of
 * {@link STAGING_DIR_NAME} when `functionGroups` splits the app: each group is
 * staged at `<distDir>/cdk-nextjs-adapter/groups/<name>/`, including the implicit
 * `default` one.
 *
 * Splitting gets its own subtree rather than reusing `app/` for the default group
 * so that a tree left over from a build with different grouping can never be
 * mistaken for this build's, and so `du` on either directory answers "how big is
 * the thing I deploy" without qualification.
 */
export const GROUPS_DIR_NAME = "groups";

/**
 * Directory inside {@link ADAPTER_DIR_NAME} holding one deployment root, relative
 * and POSIX. `undefined` means "not splitting", which is its own layout rather
 * than a group named `default`.
 */
export function groupStagingDirName(group?: string): string {
  return group === undefined ? STAGING_DIR_NAME : `${GROUPS_DIR_NAME}/${group}`;
}

/** {@link AdapterManifest}, written inside {@link ADAPTER_DIR_NAME}. */
export const MANIFEST_FILE_NAME = "manifest.json";

/**
 * Reserved key inside the staging tree that cdk-nextjs's own bundled runtime
 * files are copied to at synth (Lambda handler
 * `cdk-nextjs-runtime/lambda.handler`). Reserved because a repo-root-relative
 * asset key could otherwise collide with it.
 */
export const RUNTIME_DIR_NAME = "cdk-nextjs-runtime";

/**
 * Where the runtime reads {@link AdapterManifest} from, given the deployment
 * root. Synth copies `manifest.json` in next to the bundled shells rather than
 * leaving it at its build-time location (`<distDir>/cdk-nextjs-adapter/`, one
 * level *above* the staging tree) so that a single asset is self-describing.
 */
export function deployedManifestPath(deploymentRoot: string): string {
  return join(deploymentRoot, RUNTIME_DIR_NAME, MANIFEST_FILE_NAME);
}

export interface AdapterManifest {
  readonly version: 1;
  readonly buildId: string;
  /**
   * From the deployment root to the Next.js project dir. "" when the app is at
   * the repo root.
   *
   * **The runtime `chdir`s here at cold start, and that is load-bearing.** Next
   * inlines `__NEXT_RELATIVE_PROJECT_DIR = relative(buildCwd, projectDir)` into
   * every entrypoint at build time (`next/dist/build/define-env.js`), and the
   * built code resolves it as `join(process.cwd(), relativeProjectDir)` to find
   * `required-server-files.json`, the prerender manifest, and the app's own
   * files. `requestMeta.relativeProjectDir` overrides it in
   * `next/dist/server/route-modules/route-module.js` but **not** in
   * `app-page-runtime.js`, which passes the inlined value through as the render
   * `dir` — so `process.cwd()` is the only mechanism that covers every
   * entrypoint type. `build-outputs.ts` asserts `buildCwd === projectDir` to
   * keep the inlined value `""` and this field the whole answer.
   */
  readonly relativeProjectDir: string;
  readonly config: AdapterManifestConfig;
  /** `ctx.routing` verbatim, including `middlewareMatchers`. */
  readonly routing: unknown;
  /**
   * Every pathname `resolveRoutes` is allowed to match: the {@link entrypoints}
   * keys plus {@link staticFiles}. Sorted and deduped.
   */
  readonly pathnames: string[];
  /**
   * Route *template* (`/blog/[slug]`) → entrypoint. Keys are basePath- and
   * locale-prefixed exactly as `resolveRoutes` reports `resolvedPathname`, so
   * the lookup is a plain index with no normalization.
   *
   * Includes dynamic *prerender* templates (notably Pages Router
   * `/_next/data/<buildId>/<locale>/blog/[slug].json`) mapped to the entrypoint
   * of the route that owns them.
   */
  readonly entrypoints: Record<string, AdapterEntrypoint>;
  readonly middleware: AdapterMiddleware | null;
  /**
   * Pathname → repo-root-relative POSIX key of the file to serve.
   *
   * A map rather than a list of pathnames because the two are not derivable from
   * each other: `/favicon.ico` is `<distDir>/server/app/favicon.ico.body`, `/404`
   * is `<distDir>/server/pages/404.html`, and a fully-static Pages Router route
   * is `<distDir>/server/pages/<route>.html`. The runtime serves these itself —
   * `NextjsStaticAssets` only uploads `<distDir>/static` and `public`, so nothing
   * in front of the compute can answer them.
   *
   * Whether the file is present in the deployment package depends on the
   * deployment type; see `stageServedStaticFiles` in `build-outputs.ts`.
   */
  readonly staticFiles: Record<string, string>;
  /**
   * Group name → the route templates that group's deployment package holds,
   * including the implicit `default`. Absent when `functionGroups` is not used.
   *
   * Every group gets the *same* manifest, because routing is identical in all of
   * them: middleware, redirects and rewrites are duplicated by design, and a
   * group has to be able to resolve a pathname it does not own in order to say so
   * rather than crash on a missing file. This field is what lets it say so.
   */
  readonly groups?: Record<string, string[]>;
}

export interface AdapterManifestConfig {
  readonly basePath: string;
  readonly trailingSlash: boolean;
  readonly assetPrefix: string;
  /**
   * `distDir` relative to the project dir — `.next` unless configured. POSIX.
   * The runtime reads `required-server-files.json` from here for the image
   * optimizer's config.
   */
  readonly distDir: string;
  /**
   * `next.config` `compress`. The runtime gzips streamed responses itself
   * (neither API Gateway in STREAM mode nor CloudFront can), so honoring this
   * is on us.
   */
  readonly compress: boolean;
  /**
   * `next.config` `generateEtags`. Honored for the files the runtime serves
   * itself, as `next start` does (`serveStatic`'s `etag` option). Absent in a
   * manifest from before the field existed, which means the default, `true`.
   */
  readonly generateEtags?: boolean;
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
