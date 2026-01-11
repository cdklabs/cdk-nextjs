import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { join as joinPosix } from "node:path/posix";
import { Construct } from "constructs";
import { NextjsType } from "../constants";
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

  constructor(scope: Construct, id: string, props: NextjsBuildProps) {
    super(scope, id);
    this.relativePathToPackage = props.relativePathToPackage || ".";
    this.props = props;
    this.dotNextPath = join(props.buildDirectory, ".next");
    this.relativePathToEntrypoint = joinPosix(
      this.props.relativePathToPackage || "",
      "server.js",
    );

    // Execute local build process
    this.runNextBuild();

    // Validate build output and set validated paths
    this.validateNextBuildOutput();

    this.buildId = this.getBuildId();
    this.publicDirEntries = this.getLocalPublicDirEntries();
  }

  /**
   * Execute local build command in the specified directory
   */
  private runNextBuild() {
    const buildCommand = this.props.buildCommand || "npm run build";

    console.log(
      `Running: "${buildCommand}" in directory: ${this.props.buildDirectory}`,
    );

    try {
      // Copy cache handler and adapter to build directory before build
      this.copyCacheHandlerToBuildDirectory();
      this.copyAdapterToBuildDirectory();

      execSync(buildCommand, {
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

    const targetCacheHandler = join(
      this.props.buildDirectory,
      "cdk-nextjs-cache-handler.mjs",
    );

    try {
      copyFileSync(sourceCacheHandler, targetCacheHandler);
      console.log(
        `Copied cache handler to build directory: ${targetCacheHandler}`,
      );
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

    const targetAdapter = join(
      this.props.buildDirectory,
      "cdk-nextjs-adapter.mjs",
    );

    try {
      copyFileSync(sourceAdapter, targetAdapter);
      console.log(`Copied adapter to build directory: ${targetAdapter}`);
    } catch (error) {
      throw new Error(`Failed to copy adapter to build directory: ${error}`);
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
      console.warn(`Failed to read public directory: ${error}`);
      return [];
    }
  }
}
