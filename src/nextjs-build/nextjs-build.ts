import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { join as joinPosix } from "node:path/posix";
import { Construct } from "constructs";
import { LOG_PREFIX, NextjsType } from "../constants";
import { NextjsBaseProps } from "../root-constructs/nextjs-base-construct";

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
  private tempCacheHandlerPath: string;
  private tempAdapterPath: string;
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
    // Initialize temporary file paths
    this.tempCacheHandlerPath = join(
      this.props.buildDirectory,
      "cdk-nextjs-cache-handler.mjs",
    );
    this.tempAdapterPath = join(
      this.props.buildDirectory,
      "cdk-nextjs-adapter.mjs",
    );
    this.buildCommand = props.buildCommand || "npm run build";

    // Execute local build process
    if (props.skipBuild !== true) {
      this.runNextBuild();
    } else {
      console.log(`${LOG_PREFIX} Skipping: ${this.buildCommand}`);
    }

    // Validate build output and set validated paths
    this.validateNextBuildOutput();

    // Replace Sharp binary with Linux-compatible version for cloud deployment
    // this.replaceSharpBinaryWithCloudComputeCompatibleArch();

    this.buildId = this.getBuildId();
    this.publicDirEntries = this.getLocalPublicDirEntries();
  }

  /**
   * Execute local build command in the specified directory
   */
  private runNextBuild() {
    console.log(
      `${LOG_PREFIX} Running: "${this.buildCommand}" in directory: ${this.props.buildDirectory}`,
    );

    try {
      // Copy cache handler and adapter to build directory before build
      this.copyCacheHandlerToBuildDirectory();
      this.copyAdapterToBuildDirectory();

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
    } finally {
      // Always clean up temporary files, regardless of success or failure
      this.cleanupTemporaryFiles();
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
   * Copy the cache handler file to the build directory before build
   * This allows the adapter to reference the cache handler during Next.js build
   */
  private copyCacheHandlerToBuildDirectory() {
    const sourceCacheHandler = join(__dirname, "cdk-nextjs-cache-handler.mjs");

    if (!existsSync(sourceCacheHandler)) {
      throw new Error(
        `Cache handler not found: ${sourceCacheHandler}. Ensure the cdk-nextjs package is properly built.`,
      );
    }

    try {
      copyFileSync(sourceCacheHandler, this.tempCacheHandlerPath);
    } catch (error) {
      throw new Error(
        `Failed to copy cache handler to build directory: ${error}`,
      );
    }
  }

  /**
   * Copy the adapter file to the build directory before build
   * This allows Next.js to use the adapter during the build process
   */
  private copyAdapterToBuildDirectory() {
    const sourceAdapter = join(__dirname, "cdk-nextjs-adapter.mjs");

    if (!existsSync(sourceAdapter)) {
      throw new Error(
        `Adapter not found: ${sourceAdapter}. Ensure the cdk-nextjs package is properly built.`,
      );
    }

    try {
      copyFileSync(sourceAdapter, this.tempAdapterPath);
    } catch (error) {
      throw new Error(`Failed to copy adapter to build directory: ${error}`);
    }
  }

  /**
   * Clean up temporary files that were copied to the build directory
   */
  private cleanupTemporaryFiles() {
    try {
      if (existsSync(this.tempCacheHandlerPath)) {
        unlinkSync(this.tempCacheHandlerPath);
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to remove cache handler: ${error}`);
    }

    try {
      if (existsSync(this.tempAdapterPath)) {
        unlinkSync(this.tempAdapterPath);
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} Failed to remove adapter: ${error}`);
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
   * In cloud, Next.js runs on linux, but developer's machine is sometimes
   * macOS or windows. Need to update .next/standalone/node_modules sharp binaries
   * to be correct for the right platform/architecture. Note, we don't need to
   * include `relativePathToPackage` because top level node_modules is symlinked to it.
   *
   * Sharp binaries can be found in different naming patterns:
   * - New format: `standalone/node_modules/@img/sharp-darwin-arm64`
   * - Old format: `standalone/node_modules/@img+sharp-darwin-arm64@0.34.5`
   * - Libvips: `standalone/node_modules/@img+sharp-libvips-darwin-arm64@1.2.4`
   */
  // private replaceSharpBinaryWithCloudComputeCompatibleArch() {
  //   try {
  //     // Find Sharp binary in the standalone build
  //     const standaloneDir = join(this.dotNextPath, "standalone");
  //     const packageDir = join(standaloneDir, this.relativePathToPackage);

  //     // Look for Sharp in node_modules
  //     const sharpModulePath = join(packageDir, "node_modules", "sharp");

  //     if (!existsSync(sharpModulePath)) {
  //       // Sharp not found, skip replacement
  //       console.log(
  //         `${LOG_PREFIX} Sharp module not found in standalone build, skipping binary replacement`,
  //       );
  //       return;
  //     }

  //     // Detect current platform
  //     const currentPlatform = process.platform;
  //     const currentArch = process.arch;

  //     console.log(
  //       `${LOG_PREFIX} Detected platform: ${currentPlatform}-${currentArch}, replacing Sharp binary for Linux deployment`,
  //     );

  //     const nodeModulesDir = join(packageDir, "node_modules");

  //     // Find current platform's Sharp binaries (try both naming patterns)
  //     const currentSharpBinaries = this.findAllSharpBinaries(
  //       nodeModulesDir,
  //       currentPlatform,
  //       currentArch,
  //     );

  //     // Determine target Linux architecture based on container architecture
  //     const targetLinuxArch = "x64"; // Could be made configurable if needed

  //     // Find Linux Sharp binaries or download them if not available
  //     let targetSharpBinaries = this.findAllSharpBinaries(
  //       nodeModulesDir,
  //       "linux",
  //       targetLinuxArch,
  //     );

  //     if (targetSharpBinaries.length === 0) {
  //       console.log(
  //         `${LOG_PREFIX} Linux Sharp binaries not found, attempting to download for linux-${targetLinuxArch}`,
  //       );

  //       // Re-scan for the downloaded binaries
  //       targetSharpBinaries = this.findAllSharpBinaries(
  //         nodeModulesDir,
  //         "linux",
  //         targetLinuxArch,
  //       );
  //     }

  //     // Replace the binary files for each Sharp binary found
  //     for (const currentBinary of currentSharpBinaries) {
  //       // Find corresponding Linux binary (match sharp vs sharp-libvips)
  //       const isLibvips = currentBinary.name.includes("libvips");
  //       const targetBinary = targetSharpBinaries.find((target) =>
  //         isLibvips
  //           ? target.name.includes("libvips")
  //           : !target.name.includes("libvips"),
  //       );

  //       if (targetBinary) {
  //         this.replaceSharpBinaryFiles(currentBinary.path, targetBinary.path);
  //         console.log(
  //           `${LOG_PREFIX} Replaced ${currentBinary.name} with ${targetBinary.name}`,
  //         );
  //       } else {
  //         console.warn(
  //           `${LOG_PREFIX} No matching Linux binary found for ${currentBinary.name}`,
  //         );
  //       }
  //     }

  //     console.log(
  //       `${LOG_PREFIX} Successfully replaced Sharp binaries from ${currentPlatform}-${currentArch} to linux-${targetLinuxArch}`,
  //     );
  //   } catch (error) {
  //     console.warn(`${LOG_PREFIX} Failed to replace Sharp binary: ${error}`);
  //     // Don't throw - this is not critical for deployment
  //   }
  // }
}
