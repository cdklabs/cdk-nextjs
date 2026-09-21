import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
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
import { useDedicatedImageFunction } from "../utils/experimental-flags";
import { getNodeArchitecture } from "../utils/get-architecture";
import { readNextConfigBasePath } from "../utils/read-next-config-base-path";

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
   * The entrypoint JavaScript file used as an argument for Node.js to run the
   * Next.js standalone server relative to the standalone directory.
   * @example "./server.js"
   * @example "./packages/ui/server.js" (monorepo)
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
   * The Next.js app's own `basePath`, read out of the build's
   * `required-server-files.json`. Normalized to a bare path segment with no
   * surrounding slashes, empty when the app sets none.
   *
   * This is the URL prefix the app generates its own links and asset hrefs
   * under, which is a distinct thing from the CDK `basePath` prop (where the
   * infrastructure serves the app, and for `NextjsStaticAssets` which key
   * prefix the objects land under). Exposed so root constructs can check that
   * the two line up where they have to.
   */
  nextConfigBasePath: string;
  /**
   * Absolute path to the directory prepared for the image optimization Lambda
   * asset: bundled handler, glibc `sharp` binaries, and `required-server-files.json`.
   * Only set for {@link NextjsType.GLOBAL_FUNCTIONS} and
   * {@link NextjsType.REGIONAL_FUNCTIONS}, and only when the dedicated image
   * optimization Lambda is enabled.
   */
  imageOptimizationAssetPath?: string;

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

    // Set entrypoint path using detected relativePathToPackage
    this.relativePathToEntrypoint = joinPosix(
      this.relativePathToPackage === "." ? "" : this.relativePathToPackage,
      "server.js",
    );

    this.buildId = this.getBuildId();
    this.publicDirEntries = this.getLocalPublicDirEntries();
    this.nextConfigBasePath = readNextConfigBasePath(this.dotNextPath);

    const standalonePath = join(this.dotNextPath, "standalone");
    const isFunctions =
      props.nextjsType === NextjsType.GLOBAL_FUNCTIONS ||
      props.nextjsType === NextjsType.REGIONAL_FUNCTIONS;

    const dedicatedImageFunction = isFunctions && useDedicatedImageFunction();

    // Strip whatever platform-specific Sharp binaries `next build`'s output
    // file tracing bundled in either way, since they're the host's (e.g.
    // macOS/glibc) rather than the deployment target's.
    this.removeExistingSharpBinaries(standalonePath);
    // The standalone server serves `_next/image` itself unless a dedicated
    // image optimization Lambda takes over that route, and it runs on
    // node:24-alpine (see functions.Dockerfile) / the same Alpine base for
    // Containers, so it needs musl binaries. Skipping this install when Sharp
    // *is* invoked from the server is silent: `imageOptimizer` catches the
    // load failure internally and returns the unoptimized original with an
    // HTTP 200.
    if (!dedicatedImageFunction) {
      this.downloadAndInstallSharpBinaries();
    }

    if (dedicatedImageFunction) {
      this.imageOptimizationAssetPath =
        this.prepareImageOptimizationAssets(standalonePath);
    }
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
   * Recursively find and remove existing Sharp platform binaries
   */
  private removeExistingSharpBinaries(standalonePath: string): void {
    const nodeModulesPath = join(standalonePath, "node_modules");
    if (!existsSync(nodeModulesPath)) {
      return;
    }

    try {
      // Use recursive readdirSync to find all Sharp binary directories and symlinks
      const allEntries = readdirSync(nodeModulesPath, {
        recursive: true,
        withFileTypes: true,
      });

      const sharpBinaryPaths: string[] = [];

      for (const entry of allEntries) {
        // Check for both directories and symlinks (pnpm creates symlinks)
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          // Match Sharp binary packages with more comprehensive patterns
          const isSharpBinary =
            entry.name.includes("sharp-") ||
            entry.name.includes("sharp-libvips");

          if (isSharpBinary) {
            // For recursive readdirSync, parentPath contains the full absolute path
            const fullPath = join(entry.parentPath, entry.name);
            sharpBinaryPaths.push(fullPath);
          }
        }
      }

      debug(
        `${LOG_PREFIX} Found ${sharpBinaryPaths.length} Sharp binary directories/symlinks to remove`,
      );

      // Remove all found Sharp binary directories and symlinks
      for (const path of sharpBinaryPaths) {
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
   * Download and install correct Sharp binaries for Linux MUSL
   */
  private downloadAndInstallSharpBinaries(): void {
    const nodeModulesPath = join(
      this.dotNextPath,
      "standalone",
      "node_modules",
    );
    const imgPath = join(nodeModulesPath, "@img");
    const arch = getNodeArchitecture();

    this.installSharpPackages(
      imgPath,
      this.getSharpBinaryPackages(
        this.findSharpPackage(nodeModulesPath),
        `linuxmusl-${arch}`,
      ),
    );
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
