import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  unlinkSync,
  mkdirSync,
  cpSync,
  renameSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { join as joinPosix } from "node:path/posix";
import { Construct } from "constructs";
// eslint-disable-next-line import/no-extraneous-dependencies
import getDebug from "debug";
import { LOG_PREFIX, NextjsType } from "../constants";
import { NextjsBaseProps } from "../root-constructs/nextjs-base-construct";
import {
  ADAPTER_DIR_NAME,
  ADAPTER_MANIFEST_VERSION,
  AdapterManifest,
  MANIFEST_FILE_NAME,
  RUNTIME_DIR_NAME,
  STAGING_DIR_NAME,
} from "../runtime/manifest";
import { useDedicatedImageFunction } from "../utils/experimental-flags";
import { getNodeArchitecture } from "../utils/get-architecture";

const debug = getDebug("cdk-nextjs:nextjs-build");

export interface NextjsBuildProps {
  /**
   * @see {@link NextjsBaseProps["buildCommand"]}
   */
  readonly buildCommand: NextjsBaseProps["buildCommand"];
  /**
   * Directory where the Next.js application is located for local builds.
   * This should contain the package.json and Next.js application files.
   */
  readonly buildDirectory: string;
  readonly nextjsType: NextjsType;
  /**
   * @see {@link NextjsBaseProps.skipBuild}
   */
  readonly skipBuild?: boolean;
}

export interface PublicDirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

/**
 * Builds Next.js assets.
 * @link https://nextjs.org/docs/pages/api-reference/next-config-js/output
 */
export class NextjsBuild extends Construct {
  /**
   * Unique id for Next.js build. Used to partition cache storage and as
   * metadata for static assets in S3 bucket.
   */
  buildId: string;
  /**
   * Absolute path to the init cache directory
   * @example "/Users/john/myapp/.next/cdk-nextjs-init-cache"
   */
  initCacheDir: string;
  /**
   * Absolute path to public. Use by CloudFront/ALB to create behaviors/rules
   * @example "/Users/john/myapp/public"
   */
  publicDirEntries: PublicDirEntry[];
  /**
   * The JavaScript file Node.js runs to serve requests, relative to the
   * deployment root. cdk-nextjs's own container shell, not `next build` output,
   * so it is the same path for every app.
   * @example "cdk-nextjs-runtime/server.mjs"
   */
  relativePathToEntrypoint: string;
  /**
   * Relative path from the standalone directory to the package containing the Next.js app.
   * This is automatically detected from the standalone build output.
   * @example "." for non-monorepo apps
   * @example "./apps/web" for monorepo apps
   */
  relativePathToPackage: string;
  /**
   * Absolute path to the .next directory containing Next.js build artifacts
   */
  dotNextPath: string;
  /**
   * Absolute path to the directory prepared for the image optimization Lambda
   * asset: bundled handler, glibc `sharp` binaries, and `required-server-files.json`.
   * Only set for {@link NextjsType.GLOBAL_FUNCTIONS} and
   * {@link NextjsType.REGIONAL_FUNCTIONS}, and only when the dedicated image
   * optimization Lambda is enabled.
   */
  imageOptimizationAssetPath?: string;
  /**
   * Absolute path to the deployment root: the staged union of every shipped
   * output's traced assets, written by the adapter's `onBuildComplete`. This is
   * the Lambda zip asset and the Docker `COPY` source.
   * @example "/Users/john/myapp/.next/cdk-nextjs-adapter/app"
   */
  deploymentRootPath: string;
  /**
   * From {@link deploymentRootPath} to the Next.js project dir, POSIX, `""` when
   * the app is at the repo root. The runtime `chdir`s here; Containers pass it to
   * their Dockerfile so `.next/static` and `public` land in the same place.
   * @see AdapterManifest.relativeProjectDir
   */
  relativeProjectDir: string;

  private props: NextjsBuildProps;
  private buildCommand: string;

  constructor(scope: Construct, id: string, props: NextjsBuildProps) {
    super(scope, id);
    this.props = props;
    this.dotNextPath = join(props.buildDirectory, ".next");

    this.buildCommand = props.buildCommand || "npm run build";

    // Set init cache directory path
    this.initCacheDir = join(
      props.buildDirectory,
      ".next",
      "cdk-nextjs-init-cache",
    );

    // Execute local build process
    if (props.skipBuild !== true) {
      this.runNextBuild();
    } else {
      debug(`${LOG_PREFIX} Skipping: ${this.buildCommand}`);
    }

    // Validate build output and set validated paths
    this.validateNextBuildOutput();

    // Auto-detect relativePathToPackage from standalone build output
    this.relativePathToPackage = this.findRelativePathToServerJs();

    this.buildId = this.getBuildId();
    this.publicDirEntries = this.getLocalPublicDirEntries();

    const standalonePath = join(this.dotNextPath, "standalone");
    const isFunctions =
      props.nextjsType === NextjsType.GLOBAL_FUNCTIONS ||
      props.nextjsType === NextjsType.REGIONAL_FUNCTIONS;

    const dedicatedImageFunction = isFunctions && useDedicatedImageFunction();

    this.deploymentRootPath = join(
      this.dotNextPath,
      ADAPTER_DIR_NAME,
      STAGING_DIR_NAME,
    );
    const manifest = this.readAdapterManifest();
    this.relativeProjectDir = manifest.relativeProjectDir;
    this.relativePathToEntrypoint = joinPosix(RUNTIME_DIR_NAME, "server.mjs");
    this.stageRuntime(isFunctions);

    // Strip whatever platform-specific Sharp binaries `next build`'s output
    // file tracing staged, since they're the host's (e.g. macOS/glibc) rather
    // than the deployment target's, then install the target's. Skipping this is
    // silent: `imageOptimizer` catches the load failure internally and returns
    // the unoptimized original with an HTTP 200.
    //
    // Functions run on the Lambda managed runtime (Amazon Linux 2023, glibc);
    // Containers run on node:24-alpine (musl). The dedicated image optimization
    // Lambda, when enabled, owns `_next/image` instead and carries its own
    // glibc binaries in its own asset, so the server needs none.
    this.removeExistingSharpBinaries(this.deploymentRootPath);
    if (!dedicatedImageFunction) {
      this.installSharpBinariesForTarget(isFunctions ? "linux" : "linuxmusl");
    }

    if (dedicatedImageFunction) {
      this.imageOptimizationAssetPath =
        this.prepareImageOptimizationAssets(standalonePath);
    }
  }

  /**
   * Read the manifest the adapter's `onBuildComplete` wrote.
   *
   * Its absence means `next build` ran without cdk-nextjs's adapter registered
   * (or with a stale `next.config`), which is worth saying plainly here: every
   * later failure — a Lambda that cannot find `manifest.json`, an empty asset —
   * is the same cause several steps downstream.
   */
  private readAdapterManifest(): AdapterManifest {
    const manifestPath = join(
      this.dotNextPath,
      ADAPTER_DIR_NAME,
      MANIFEST_FILE_NAME,
    );
    if (!existsSync(manifestPath)) {
      throw new Error(
        `cdk-nextjs adapter manifest not found at ${manifestPath}. ` +
          `"${this.buildCommand}" must run a Next.js build with cdk-nextjs's ` +
          `adapter registered in next.config: ` +
          `\`adapter: "cdk-nextjs/lib/adapter/adapter.mjs"\`.`,
      );
    }
    const manifest: AdapterManifest = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    );
    if (manifest.version !== ADAPTER_MANIFEST_VERSION) {
      throw new Error(
        `The cdk-nextjs adapter manifest at ${manifestPath} is version ` +
          `${manifest.version}, but this version of cdk-nextjs reads version ` +
          `${ADAPTER_MANIFEST_VERSION}. The adapter that wrote it and the ` +
          `constructs reading it come from the same package, so this means two ` +
          `cdk-nextjs versions are installed, or the build output is stale.`,
      );
    }
    return manifest;
  }

  /**
   * Copy cdk-nextjs's own bundled request-handling shell and the manifest into
   * `<deploymentRoot>/cdk-nextjs-runtime/`, which is where
   * `deploymentRootOf`/`deployedManifestPath` expect to find them.
   *
   * Only the shell the deployment type actually runs is copied — the Lambda
   * handler for Functions, the `node:http` server for Containers — so nothing
   * ships ~1.5 MB of dead code and the tree says which type produced it. Both
   * are copied from this package's `lib/`, next to the compiled construct.
   */
  private stageRuntime(isFunctions: boolean): void {
    const shell = isFunctions ? "lambda.mjs" : "server.mjs";
    const source = join(__dirname, "..", "runtime", shell);
    if (!existsSync(source)) {
      throw new Error(
        `cdk-nextjs's bundled runtime shell not found at ${source}. Ensure the ` +
          `cdk-nextjs package is properly built.`,
      );
    }

    const runtimeDir = join(this.deploymentRootPath, RUNTIME_DIR_NAME);
    // Removed rather than merged: a stale shell from the other deployment type
    // would otherwise sit in the asset and change its hash for no reason.
    rmSync(runtimeDir, { recursive: true, force: true });
    mkdirSync(runtimeDir, { recursive: true });
    cpSync(source, join(runtimeDir, shell));
    cpSync(
      join(this.dotNextPath, ADAPTER_DIR_NAME, MANIFEST_FILE_NAME),
      join(runtimeDir, MANIFEST_FILE_NAME),
    );
    debug(
      `${LOG_PREFIX} Staged ${shell} and ${MANIFEST_FILE_NAME} in ${runtimeDir}`,
    );
  }

  /**
   * Execute local build command in the specified directory
   */
  private runNextBuild() {
    console.log(
      `${LOG_PREFIX} Running: "${this.buildCommand}" in directory: ${this.props.buildDirectory}`,
    );

    // Clean existing cache directory to avoid stale data from previous builds
    if (existsSync(this.initCacheDir)) {
      rmSync(this.initCacheDir, { recursive: true, force: true });
      debug(`Cleaned existing cache directory: ${this.initCacheDir}`);
    }

    try {
      execSync(this.buildCommand, {
        stdio: "inherit",
        cwd: this.props.buildDirectory,
        env: {
          ...process.env,
          CDK_NEXTJS_INIT_CACHE_DIR: this.initCacheDir,
        },
      });

      // Copy patch-fetch.js into client JS bundle after build only for NextjsGlobalFunctions
      if (this.props.nextjsType === NextjsType.GLOBAL_FUNCTIONS) {
        this.patchFetchInClientJs();
      }
    } catch (error) {
      throw new Error(`Local build failed: ${error}`);
    }
  }

  /**
   * Validate Next.js build output
   * All builds must be standalone - no fallback to regular builds
   */
  private validateNextBuildOutput(): void {
    const standaloneDir = join(this.dotNextPath, "standalone");
    // Standalone directory is mandatory
    if (!existsSync(standaloneDir)) {
      throw new Error(
        `Standalone build directory not found: ${standaloneDir}. ` +
          `All builds must be configured for standalone output. ` +
          `Please ensure your next.config.js includes 'output: "standalone"'.`,
      );
    }
    // Additional validation (server.js with .next sibling) happens in findRelativePathToServerJs()
  }

  /**
   * Find entrypoint client side js files to patch `fetch` only for NextjsGlobalFunctions
   */
  private patchFetchInClientJs() {
    const staticChunksPath = join(this.dotNextPath, "static", "chunks");
    const chunkFiles = readdirSync(staticChunksPath).filter(
      (file: string) =>
        // main-app- for webpack, turbopack- for turbo
        file.startsWith("main-app-") ||
        (file.startsWith("turbopack-") && file.endsWith(".js")),
    );

    if (chunkFiles.length === 0) {
      throw new Error("No client side js entrypoint files found");
    }

    // Read the patch-fetch.js content
    const patchFetchPath = join(__dirname, "patch-fetch.js");
    if (!existsSync(patchFetchPath)) {
      throw new Error("patch-fetch.js not found");
    }

    const patchFetchContent = readFileSync(patchFetchPath, "utf-8");

    // Prepend patch-fetch logic to each entrypoint
    for (const chunkFile of chunkFiles) {
      const chunkFilePath = join(staticChunksPath, chunkFile);
      const originalContent = readFileSync(chunkFilePath, "utf-8");
      const patchedContent = patchFetchContent + "\n" + originalContent;
      writeFileSync(chunkFilePath, patchedContent);
    }
  }

  /**
   * Automatically finds the relative path from standalone directory to the
   * package containing server.js by searching for server.js with a .next sibling.
   * @returns "." for non-monorepo apps, or relative path like "app-playground" for monorepo apps
   */
  private findRelativePathToServerJs(): string {
    const standaloneDir = join(this.dotNextPath, "standalone");

    if (!existsSync(standaloneDir)) {
      throw new Error(
        `Cannot detect relativePathToPackage: standalone directory not found at ${standaloneDir}`,
      );
    }

    const findServerJs = (
      dir: string,
      relativePath: string = "",
    ): string | null => {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory() && entry.name !== "node_modules") {
          // Recursively search directories (skip node_modules at root level)
          const result = findServerJs(fullPath, join(relativePath, entry.name));
          if (result !== null) return result;
        } else if (entry.isFile() && entry.name === "server.js") {
          // Check if this server.js has a .next sibling directory
          const parentDir = dir;
          const dotNextPath = join(parentDir, ".next");
          if (existsSync(dotNextPath)) {
            return relativePath || ".";
          }
        }
      }
      return null;
    };

    const result = findServerJs(standaloneDir);
    if (result === null) {
      throw new Error(
        `Cannot detect relativePathToPackage: Could not find server.js with .next sibling in ${standaloneDir}. ` +
          `Please ensure Next.js build completed successfully or provide relativePathToPackage manually.`,
      );
    }

    debug(`${LOG_PREFIX} Auto-detected relativePathToPackage: "${result}"`);
    return result;
  }

  /**
   * Get build ID from .next directory
   */
  private getBuildId(): string {
    const buildIdPath = join(this.dotNextPath, "BUILD_ID");
    // Verify BUILD_ID exists (needed for cache partitioning)
    if (!existsSync(buildIdPath)) {
      throw new Error(
        `BUILD_ID file not found at ${buildIdPath}. ` +
          `Ensure Next.js build completed successfully.`,
      );
    }
    // BUILD_ID existence is already validated in validateNextBuildOutput()
    return readFileSync(buildIdPath, "utf-8").trim();
  }

  /**
   * Get public directory entries from local filesystem
   */
  private getLocalPublicDirEntries(): PublicDirEntry[] {
    const publicDirPath = join(this.props.buildDirectory, "public");
    if (!existsSync(publicDirPath)) {
      return [];
    }

    try {
      return readdirSync(publicDirPath, { withFileTypes: true }).map(
        (entry: any) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }),
      );
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to read public directory: ${error}`);
      return [];
    }
  }

  /**
   * Recursively find and remove existing Sharp platform binaries.
   *
   * `root` is walked whole rather than just its `node_modules`: the staged tree
   * is keyed by repo-root-relative path, so in a monorepo the `node_modules`
   * holding `sharp` is several directories down.
   */
  private removeExistingSharpBinaries(root: string): void {
    if (!existsSync(root)) {
      return;
    }

    try {
      // Use recursive readdirSync to find all Sharp binary directories and symlinks
      const allEntries = readdirSync(root, {
        recursive: true,
        withFileTypes: true,
      });

      // Symlinks are unlinked, not `rmSync`ed, and they go first. pnpm points
      // several links at one store directory, and `rmSync(…, { recursive: true,
      // force: true })` *silently no-ops* on a symlink whose target is already
      // gone — `force` swallows the ENOENT its `rmdir` gets. Removing a store
      // directory before its links therefore left dangling
      // `@img/sharp-darwin-arm64` entries in the asset, which is a latent ENOENT
      // in whatever next dereferences the tree (`cdk-assets` does, when it zips).
      const symlinks: string[] = [];
      const directories: string[] = [];

      for (const entry of allEntries) {
        // `sharp-libvips-<platform>` is covered by `sharp-`; the store keys
        // (`@img+sharp-darwin-arm64@0.35.4`) match on the same substring.
        if (!entry.name.includes("sharp-")) continue;
        // For recursive readdirSync, parentPath contains the full absolute path
        const fullPath = join(entry.parentPath, entry.name);
        if (entry.isSymbolicLink()) {
          symlinks.push(fullPath);
        } else if (entry.isDirectory()) {
          directories.push(fullPath);
        }
      }

      debug(
        `${LOG_PREFIX} Removing ${symlinks.length} Sharp binary symlinks and ${directories.length} directories`,
      );

      for (const path of symlinks) {
        try {
          unlinkSync(path);
          debug(`${LOG_PREFIX} Unlinked: ${path}`);
        } catch (error) {
          console.warn(
            `${LOG_PREFIX} Warning: Could not unlink ${path}: ${error}`,
          );
        }
      }
      for (const path of directories) {
        try {
          rmSync(path, { recursive: true, force: true });
          debug(`${LOG_PREFIX} Removed: ${path}`);
        } catch (error) {
          console.warn(
            `${LOG_PREFIX} Warning: Could not remove ${path}: ${error}`,
          );
        }
      }
    } catch (error) {
      console.warn(
        `${LOG_PREFIX} Warning: Could not read node_modules directory: ${error}`,
      );
    }
  }

  /**
   * Install the `sharp` platform binaries the deployment target needs into the
   * staged tree.
   *
   * They go next to the staged `sharp` package rather than at the top of the
   * tree, because that is the first place Node looks from `sharp`'s own
   * `require("@img/sharp-<platform>")` under every installer layout: a sibling
   * `@img` inside `node_modules/.pnpm/sharp@x/node_modules/` for pnpm, and
   * `node_modules/@img/` for a hoisted install.
   *
   * @param libc `"linux"` (glibc, the Lambda managed runtime) or `"linuxmusl"`
   * (Alpine, the container images).
   */
  private installSharpBinariesForTarget(libc: "linux" | "linuxmusl"): void {
    const sharpSource = this.findStagedSharpPackage();
    if (!sharpSource) {
      console.warn(
        `${LOG_PREFIX} "sharp" not found in the staged build output. Add "sharp" as a dependency of your Next.js app to enable image optimization.`,
      );
      return;
    }

    this.installSharpPackages(
      join(sharpSource, "..", "@img"),
      this.getSharpBinaryPackages(
        sharpSource,
        `${libc}-${getNodeArchitecture()}`,
      ),
    );
  }

  /**
   * Locate `sharp`'s JS wrapper anywhere in the staged tree.
   *
   * Unlike a standalone build there is no single `node_modules` to look in: the
   * tree mirrors repo-root-relative paths, so the search is by directory name.
   */
  private findStagedSharpPackage(): string | undefined {
    const entries = readdirSync(this.deploymentRootPath, {
      recursive: true,
      withFileTypes: true,
    });
    const candidates: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name === "sharp") {
        const path = join(entry.parentPath, entry.name);
        if (existsSync(join(path, "package.json"))) {
          candidates.push(path);
        }
      }
    }
    // Sorted for determinism: an app could have two `sharp` copies at different
    // versions, and which one the *server's* `next` resolves is not knowable
    // from here. Shortest path wins as the closest to a hoisted install.
    candidates.sort((a, b) => a.length - b.length || a.localeCompare(b));
    if (candidates.length > 1) {
      debug(
        `${LOG_PREFIX} Multiple staged "sharp" copies; using ${candidates[0]}`,
      );
    }
    return candidates[0];
  }

  /**
   * Assemble the deployment asset for the dedicated image optimization
   * Lambda: the pre-bundled handler (from this package's own `lib/` output),
   * `sharp`'s JS wrapper (already dereferenced from the pnpm store by Next's
   * output file tracing into the standalone build), glibc `sharp` binaries
   * (the standard Lambda managed runtime is Amazon Linux 2023/glibc, unlike
   * the musl binaries the Docker/Lambda Web Adapter server function needs),
   * and `required-server-files.json` (read by the handler at cold start to
   * build `nextConfig`).
   */
  private prepareImageOptimizationAssets(standalonePath: string): string {
    const assetPath = join(this.dotNextPath, "cdk-nextjs-image-optimization");
    const nodeModulesPath = join(assetPath, "node_modules");
    const imgPath = join(nodeModulesPath, "@img");

    rmSync(assetPath, { recursive: true, force: true });
    mkdirSync(imgPath, { recursive: true });

    // Pre-bundled by esbuild into this package's own lib/ output.
    cpSync(join(__dirname, "..", "image-optimization"), assetPath, {
      recursive: true,
    });

    const sharpSource = this.findSharpPackage(
      join(standalonePath, "node_modules"),
    );
    if (sharpSource) {
      this.copySharpRuntime(sharpSource, nodeModulesPath);
    } else {
      console.warn(
        `${LOG_PREFIX} "sharp" not found in standalone build output. Add "sharp" as a dependency of your Next.js app to enable image optimization.`,
      );
    }

    const requiredServerFiles = join(
      this.dotNextPath,
      "required-server-files.json",
    );
    if (!existsSync(requiredServerFiles)) {
      throw new Error(
        `${LOG_PREFIX} "required-server-files.json" not found at ${requiredServerFiles}. The image optimization Lambda reads it at cold start to build its Next.js config.`,
      );
    }
    cpSync(requiredServerFiles, join(assetPath, "required-server-files.json"));

    const arch = getNodeArchitecture();
    this.installSharpPackages(
      imgPath,
      this.getSharpBinaryPackages(sharpSource, `linux-${arch}`),
    );

    return assetPath;
  }

  /**
   * Locate `sharp`'s JS wrapper inside a standalone `node_modules`.
   *
   * Next's output file tracing preserves the installer's on-disk layout, so
   * npm/yarn produce a hoisted `node_modules/sharp` while pnpm only
   * materializes `node_modules/.pnpm/sharp@<version>/node_modules/sharp`.
   */
  private findSharpPackage(nodeModulesPath: string): string | undefined {
    const hoisted = join(nodeModulesPath, "sharp");
    if (existsSync(join(hoisted, "package.json"))) {
      return hoisted;
    }

    const pnpmPath = join(nodeModulesPath, ".pnpm");
    if (!existsSync(pnpmPath)) {
      return undefined;
    }

    const candidates = readdirSync(pnpmPath)
      .filter((name) => name.startsWith("sharp@"))
      .sort();
    for (const candidate of candidates.reverse()) {
      const nested = join(pnpmPath, candidate, "node_modules", "sharp");
      if (existsSync(join(nested, "package.json"))) {
        return nested;
      }
    }

    return undefined;
  }

  /**
   * Copy `sharp` plus the transitive `dependencies` closure `require("sharp")`
   * pulls in (`@img/colour`, `detect-libc`, `semver`) into `targetPath`.
   *
   * Copying only `sharp` itself leaves those requires unresolvable, and
   * `imageOptimizer` swallows the resulting `MODULE_NOT_FOUND` by falling back
   * to serving the unoptimized original, so the omission is otherwise silent.
   */
  private copySharpRuntime(sharpSource: string, targetPath: string): void {
    // Under pnpm a package's dependencies are symlinked into the sibling
    // directory alongside it, which is also where a hoisted layout keeps
    // them, so the same lookup covers both.
    const lookupPath = join(sharpSource, "..");
    const queue = ["sharp"];
    const copied = new Set<string>();

    while (queue.length > 0) {
      const name = queue.shift()!;
      if (copied.has(name)) {
        continue;
      }

      const source = name === "sharp" ? sharpSource : join(lookupPath, name);
      if (!existsSync(join(source, "package.json"))) {
        console.warn(
          `${LOG_PREFIX} "sharp" dependency "${name}" not found in standalone build output; image optimization may fall back to serving unoptimized images.`,
        );
        continue;
      }

      // `dereference` resolves pnpm's symlinks into real files, since the
      // Lambda asset is a standalone directory with no store to link into.
      cpSync(source, join(targetPath, name), {
        recursive: true,
        dereference: true,
      });
      copied.add(name);

      const manifest = JSON.parse(
        readFileSync(join(source, "package.json"), "utf-8"),
      );
      // Platform binaries are optionalDependencies, installed separately at
      // the versions this same manifest pins, so only `dependencies` here.
      queue.push(...Object.keys(manifest.dependencies ?? {}));
    }

    debug(
      `${LOG_PREFIX} Copied sharp runtime: ${[...copied].sort().join(", ")}`,
    );
  }

  /**
   * Resolve the `@img/sharp-<platform>` and `@img/sharp-libvips-<platform>`
   * versions to install for a given platform.
   *
   * These must match the `sharp` JS wrapper that output file tracing put in
   * the standalone build: `sharp`'s `lib/libvips.js` compares the binary's
   * reported libvips version against its own `minimumLibvipsVersion` and
   * throws at load when they disagree. `sharp` pins both in its
   * `optionalDependencies`, so that manifest is the authoritative source.
   */
  private getSharpBinaryPackages(
    sharpSource: string | undefined,
    platform: string,
  ): { name: string; version: string }[] {
    const fallback = [
      { name: `sharp-libvips-${platform}`, version: "1.2.4" },
      { name: `sharp-${platform}`, version: "0.34.5" },
    ];

    if (!sharpSource) {
      return fallback;
    }

    const manifest = JSON.parse(
      readFileSync(join(sharpSource, "package.json"), "utf-8"),
    );
    const optionalDependencies: Record<string, string> =
      manifest.optionalDependencies ?? {};

    return fallback.map((pkg) => {
      const version = optionalDependencies[`@img/${pkg.name}`];
      if (!version) {
        console.warn(
          `${LOG_PREFIX} sharp@${manifest.version} does not pin "@img/${pkg.name}"; falling back to ${pkg.version}.`,
        );
        return pkg;
      }
      return { name: pkg.name, version };
    });
  }

  /**
   * Download (with caching) and extract Sharp's platform-specific binary
   * packages into `imgPath`.
   */
  private installSharpPackages(
    imgPath: string,
    packages: { name: string; version: string }[],
  ): void {
    const cacheDir = join(tmpdir(), "cdk-nextjs-sharp-cache");
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }

    for (const pkg of packages) {
      try {
        const targetDir = join(imgPath, pkg.name);
        const url = `https://registry.npmjs.org/@img/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`;

        // Create a consistent filename based on package name and version
        const cacheFileName = `${pkg.name}-${pkg.version}.tgz`;
        const cachedFile = join(cacheDir, cacheFileName);

        // Check if we already have a valid package cached; re-download if
        // a previous run left behind a truncated/corrupt download
        if (existsSync(cachedFile) && this.isCachedFileValid(cachedFile)) {
          debug(
            `${LOG_PREFIX} Using cached ${pkg.name}@${pkg.version} from ${cachedFile}`,
          );
        } else {
          debug(`${LOG_PREFIX} Downloading ${pkg.name}@${pkg.version}...`);

          // Download to a process-unique temp file in the same directory,
          // then atomically rename it onto the shared cache path. Concurrent
          // synth processes (e.g. Turborepo running multiple `cdk` commands)
          // share this cache dir, so writing directly to `cachedFile` risks
          // another process extracting a half-written file. Renaming within
          // the same filesystem is atomic, so readers only ever see a
          // complete file, whichever process wins the race.
          const tempFile = join(
            cacheDir,
            `${cacheFileName}.${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
          );
          try {
            // --fail makes curl exit non-zero on HTTP errors and --retry
            // handles transient connection drops so a partial transfer
            // isn't cached as valid.
            execSync(
              `curl -L --fail --retry 3 --retry-delay 1 -o "${tempFile}" "${url}"`,
              { stdio: "pipe" },
            );

            if (!this.isCachedFileValid(tempFile)) {
              throw new Error(
                `Downloaded file for ${pkg.name}@${pkg.version} is empty or missing: ${tempFile}`,
              );
            }

            renameSync(tempFile, cachedFile);
          } finally {
            if (existsSync(tempFile)) {
              rmSync(tempFile, { force: true });
            }
          }

          debug(
            `${LOG_PREFIX} Cached ${pkg.name}@${pkg.version} to ${cachedFile}`,
          );
        }

        mkdirSync(targetDir, { recursive: true });
        execSync(
          `tar -xzf "${cachedFile}" -C "${targetDir}" --strip-components=1`,
          { stdio: "pipe" },
        );

        debug(`${LOG_PREFIX} Installed ${pkg.name}@${pkg.version}`);
      } catch (error) {
        console.error(`${LOG_PREFIX} Failed to install ${pkg.name}: ${error}`);
        throw error;
      }
    }
  }

  /**
   * Checks that a cached Sharp binary archive is non-empty. Guards against
   * a truncated/corrupt download (e.g. from a dropped connection) being
   * reused across synth operations.
   */
  private isCachedFileValid(filePath: string): boolean {
    try {
      return statSync(filePath).size > 0;
    } catch {
      return false;
    }
  }
}
