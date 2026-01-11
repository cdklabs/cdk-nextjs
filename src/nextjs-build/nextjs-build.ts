import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
   * Absolute path to the .next directory containing build output
   */
  nextOutputPath: string;

  // Validated build paths - set by validateNextBuildOutput()
  private buildIdPath!: string;
  private standaloneDir!: string;
  private staticChunksPath!: string;
  private publicDirPath!: string;

  private props: NextjsBuildProps;
  private relativePathToPackage: string;

  constructor(scope: Construct, id: string, props: NextjsBuildProps) {
    super(scope, id);
    this.relativePathToPackage = props.relativePathToPackage || ".";
    this.props = props;
    this.relativePathToEntrypoint = this.getRelativeEntrypointPath();

    this.nextOutputPath = join(
      props.buildDirectory,
      this.relativePathToPackage,
      ".next",
    );

    // Execute local build process
    this.executeLocalBuild();

    // Validate build output and set validated paths
    this.validateNextBuildOutput();

    this.buildId = this.getLocalBuildId();
    this.publicDirEntries = this.getLocalPublicDirEntries();

    // Docker images are no longer created for local builds
    // Container and function images will be handled differently in future tasks
  }

  private getRelativeEntrypointPath() {
    // joinPosix b/c this will be used in linux container
    return joinPosix(this.props.relativePathToPackage || "", "server.js");
  }

  /**
   * Execute local build command in the specified directory
   */
  private executeLocalBuild() {
    const buildCommand = this.props.buildCommand || "npm run build";
    const buildDirectory = join(
      this.props.buildDirectory,
      this.relativePathToPackage,
    );

    console.log(
      `Executing local build: ${buildCommand} in directory: ${buildDirectory}`,
    );

    try {
      // Copy cache handler and adapter to build directory before build
      this.copyCacheHandlerToBuildDirectory();
      this.copyAdapterToBuildDirectory();

      execSync(buildCommand, {
        stdio: "inherit",
        cwd: buildDirectory,
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
    // Set up all the paths we'll need
    this.buildIdPath = join(this.nextOutputPath, "BUILD_ID");
    this.standaloneDir = join(this.nextOutputPath, "standalone");
    this.staticChunksPath = join(this.nextOutputPath, "static", "chunks");
    this.publicDirPath = join(
      this.props.buildDirectory,
      this.relativePathToPackage,
      "public",
    );

    // Standalone directory is mandatory
    if (!existsSync(this.standaloneDir)) {
      throw new Error(
        `Standalone build directory not found: ${this.standaloneDir}. ` +
          `All builds must be configured for standalone output. ` +
          `Please ensure your next.config.js includes 'output: "standalone"'.`,
      );
    }

    // Validate standalone build structure
    // Use relativePathToPackage directly instead of just the package name
    const standalonePackageDir = join(
      this.standaloneDir,
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

    // Verify BUILD_ID exists (needed for cache partitioning)
    if (!existsSync(this.buildIdPath)) {
      throw new Error(
        `BUILD_ID file not found at ${this.buildIdPath}. ` +
          `Ensure Next.js build completed successfully.`,
      );
    }
  }
  /**
   * Copy the cache handler file to the build directory before build
   * This allows the adapter to reference the cache handler during Next.js build
   */
  private copyCacheHandlerToBuildDirectory() {
    // Find the cache handler file in the cdk-nextjs package
    const packageRoot = dirname(require.resolve("cdk-nextjs/package.json"));
    const sourceCacheHandler = join(
      packageRoot,
      "lib",
      "nextjs-build",
      "cdk-nextjs-cache-handler.mjs",
    );

    if (!existsSync(sourceCacheHandler)) {
      throw new Error(
        `Cache handler not found: ${sourceCacheHandler}. Ensure the cdk-nextjs package is properly built.`,
      );
    }

    // Copy to the build directory (where package.json is located)
    const buildDirectory = join(
      this.props.buildDirectory,
      this.relativePathToPackage,
    );

    const targetCacheHandler = join(
      buildDirectory,
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
    // Find the adapter file in the cdk-nextjs package
    const packageRoot = dirname(require.resolve("cdk-nextjs/package.json"));
    const sourceAdapter = join(
      packageRoot,
      "lib",
      "nextjs-build",
      "cdk-nextjs-adapter.mjs",
    );

    if (!existsSync(sourceAdapter)) {
      throw new Error(
        `Adapter not found: ${sourceAdapter}. Ensure the cdk-nextjs package is properly built.`,
      );
    }

    // Copy to the build directory (where package.json is located)
    const buildDirectory = join(
      this.props.buildDirectory,
      this.relativePathToPackage,
    );

    const targetAdapter = join(buildDirectory, "cdk-nextjs-adapter.mjs");

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
    if (!existsSync(this.staticChunksPath)) {
      console.warn(
        "Static chunks directory not found, skipping patch-fetch logic",
      );
      return;
    }

    try {
      const chunkFiles = readdirSync(this.staticChunksPath).filter(
        (file: string) =>
          // main-app- for webpack, turbopack- for turbo
          file.startsWith("main-app-") ||
          (file.startsWith("turbopack-") && file.endsWith(".js")),
      );

      if (chunkFiles.length === 0) {
        console.warn(
          "No main-app-*.js files found, skipping patch-fetch logic",
        );
        return;
      }

      // Read the patch-fetch.js content
      const patchFetchPath = join(__dirname, "patch-fetch.js");
      if (!existsSync(patchFetchPath)) {
        console.warn("patch-fetch.js not found, skipping patch logic");
        return;
      }

      const patchFetchContent = readFileSync(patchFetchPath, "utf-8");

      // Prepend patch-fetch logic to each main-app-*.js file
      for (const chunkFile of chunkFiles) {
        const chunkFilePath = join(this.staticChunksPath, chunkFile);
        const originalContent = readFileSync(chunkFilePath, "utf-8");
        const patchedContent = patchFetchContent + "\n" + originalContent;
        writeFileSync(chunkFilePath, patchedContent);
        console.log(`Patched ${chunkFile} with fetch logic`);
      }
    } catch (error) {
      console.warn(`Failed to execute patch-fetch logic: ${error}`);
    }
  }

  /**
   * Get build ID from local .next directory
   */
  private getLocalBuildId(): string {
    // BUILD_ID existence is already validated in validateNextBuildOutput()
    return readFileSync(this.buildIdPath, "utf-8").trim();
  }

  /**
   * Get public directory entries from local filesystem
   */
  private getLocalPublicDirEntries(): PublicDirEntry[] {
    if (!existsSync(this.publicDirPath)) {
      return [];
    }

    try {
      return readdirSync(this.publicDirPath, { withFileTypes: true }).map(
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
