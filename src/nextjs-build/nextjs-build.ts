import { execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { join as joinPosix } from "node:path/posix";
import { Construct } from "constructs";
// eslint-disable-next-line import/no-extraneous-dependencies
import getDebug from "debug";
import { LOG_PREFIX, NextjsType } from "../constants";
import { NextjsBaseProps } from "../root-constructs/nextjs-base-construct";
import { tmpdir } from "node:os";

const debug = getDebug("nextjs-build");

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
  /**
   * @see {@link NextjsBaseProps.relativePathToPackage}
   */
  readonly relativePathToPackage?: NextjsBaseProps["relativePathToPackage"];
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
   * Absolute path to the .next directory containing Next.js build artifacts
   */
  dotNextPath: string;

  private props: NextjsBuildProps;
  private relativePathToPackage: string;
  private buildCommand: string;

  constructor(scope: Construct, id: string, props: NextjsBuildProps) {
    super(scope, id);
    this.relativePathToPackage = props.relativePathToPackage || ".";
    this.props = props;
    this.dotNextPath = join(props.buildDirectory, ".next");
    this.relativePathToEntrypoint = joinPosix(
      this.props.relativePathToPackage || "",
      "server.js",
    );

    this.buildCommand = props.buildCommand || "npm run build";

    // Execute local build process
    if (props.skipBuild !== true) {
      this.runNextBuild();
    } else {
      debug(`${LOG_PREFIX} Skipping: ${this.buildCommand}`);
    }

    // Validate build output and set validated paths
    this.validateNextBuildOutput();

    // Sharp binary replacement is now always performed to ensure cloud compatibility
    // This removes platform-specific binaries and downloads Linux binaries for deployment

    this.buildId = this.getBuildId();
    this.publicDirEntries = this.getLocalPublicDirEntries();

    const standalonePath = join(this.dotNextPath, "standalone");
    this.removeExistingSharpBinaries(standalonePath);
    this.downloadAndInstallSharpBinaries();
  }

  /**
   * Execute local build command in the specified directory
   */
  private runNextBuild() {
    console.log(
      `${LOG_PREFIX} Running: "${this.buildCommand}" in directory: ${this.props.buildDirectory}`,
    );

    try {
      execSync(this.buildCommand, {
        stdio: "inherit",
        cwd: this.props.buildDirectory,
        env: process.env,
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
   * Validate Next.js build output and set validated paths as class variables
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

    // Validate standalone build structure
    // Use relativePathToPackage directly instead of just the package name
    const standalonePackageDir = join(
      standaloneDir,
      this.relativePathToPackage,
    );

    if (!existsSync(standalonePackageDir)) {
      throw new Error(
        `Standalone package directory not found: ${standalonePackageDir}. ` +
          `Ensure Next.js build completed successfully with output: 'standalone'.`,
      );
    }

    // Check required files in standalone package directory
    const requiredFiles = ["server.js"];
    for (const file of requiredFiles) {
      const filePath = join(standalonePackageDir, file);
      if (!existsSync(filePath)) {
        throw new Error(
          `Required standalone build file missing: ${filePath}. ` +
            `Ensure Next.js build completed successfully with output: 'standalone'.`,
        );
      }
    }

    // Check required directories in standalone package directory
    const requiredDirectories = [".next"];
    for (const dir of requiredDirectories) {
      const dirPath = join(standalonePackageDir, dir);
      if (!existsSync(dirPath)) {
        throw new Error(
          `Required standalone build directory missing: ${dirPath}. ` +
            `Ensure Next.js build completed successfully.`,
        );
      }
    }
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

    // Create a consistent cache directory for Sharp packages
    const cacheDir = join(tmpdir(), "cdk-nextjs-sharp-cache");
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }

    // Ensure @img directory exists
    if (!existsSync(imgPath)) {
      mkdirSync(imgPath, { recursive: true });
    }

    // Detect architecture for correct Sharp binaries
    const arch = process.arch.startsWith("arm") ? "arm64" : "x64";

    // Sharp binary packages to download
    const sharpPackages = [
      {
        name: `sharp-libvips-linuxmusl-${arch}`,
        version: "1.2.4",
        url: `https://registry.npmjs.org/@img/sharp-libvips-linuxmusl-${arch}/-/sharp-libvips-linuxmusl-${arch}-1.2.4.tgz`,
      },
      {
        name: `sharp-linuxmusl-${arch}`,
        version: "0.34.5",
        url: `https://registry.npmjs.org/@img/sharp-linuxmusl-${arch}/-/sharp-linuxmusl-${arch}-0.34.5.tgz`,
      },
    ];

    for (const pkg of sharpPackages) {
      try {
        const targetDir = join(imgPath, pkg.name);

        // Create a consistent filename based on package name and version
        const cacheFileName = `${pkg.name}-${pkg.version}.tgz`;
        const cachedFile = join(cacheDir, cacheFileName);

        // Check if we already have this package cached
        if (existsSync(cachedFile)) {
          debug(
            `${LOG_PREFIX} Using cached ${pkg.name}@${pkg.version} from ${cachedFile}`,
          );
        } else {
          debug(`${LOG_PREFIX} Downloading ${pkg.name}@${pkg.version}...`);

          // Download to cache directory with consistent name
          execSync(`curl -L -o "${cachedFile}" "${pkg.url}"`, {
            stdio: "pipe",
          });
          debug(
            `${LOG_PREFIX} Cached ${pkg.name}@${pkg.version} to ${cachedFile}`,
          );
        }

        // Create target directory
        mkdirSync(targetDir, { recursive: true });

        // Extract from cached file
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
}
