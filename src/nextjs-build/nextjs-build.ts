import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { basename, join } from "node:path";
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
  nextOutputPath?: string;
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
    this.verifyBuildOutput();
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
      execSync(buildCommand, {
        stdio: "inherit",
        cwd: buildDirectory,
        env: process.env,
      });

      // Execute patch-fetch.js logic locally after build
      this.executePatchFetchLogic();
    } catch (error) {
      throw new Error(`Local build failed: ${error}`);
    }
  }

  /**
   * Find entrypoint client side js files to patch `fetch` only for NextjsGlobalFunctions
   */
  private executePatchFetchLogic() {
    if (!this.nextOutputPath) {
      console.warn(
        "Next output path not available, skipping patch-fetch logic",
      );
      return;
    }

    const nextOutputPath = this.nextOutputPath;
    const staticChunksPath = join(nextOutputPath, "static", "chunks");

    if (!existsSync(staticChunksPath)) {
      console.warn(
        "Static chunks directory not found, skipping patch-fetch logic",
      );
      return;
    }

    try {
      const chunkFiles = fs.readdirSync(staticChunksPath).filter(
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

      const patchFetchContent = fs.readFileSync(patchFetchPath, "utf-8");

      // Prepend patch-fetch logic to each main-app-*.js file
      for (const chunkFile of chunkFiles) {
        const chunkFilePath = path.join(staticChunksPath, chunkFile);
        const originalContent = fs.readFileSync(chunkFilePath, "utf-8");
        const patchedContent = patchFetchContent + "\n" + originalContent;
        fs.writeFileSync(chunkFilePath, patchedContent);
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
    if (!this.nextOutputPath) {
      throw new Error("Next output path not available for local build ID");
    }
    const buildIdPath = join(this.nextOutputPath, "BUILD_ID");
    if (!existsSync(buildIdPath)) {
      throw new Error(
        `BUILD_ID file not found at ${buildIdPath}. Ensure Next.js build completed successfully.`,
      );
    }
    return readFileSync(buildIdPath, "utf-8").trim();
  }

  /**
   * Get public directory entries from local filesystem
   */
  private getLocalPublicDirEntries(): PublicDirEntry[] {
    const publicDirPath = join(
      this.props.buildDirectory!,
      this.relativePathToPackage,
      "public",
    );

    if (!existsSync(publicDirPath)) {
      return [];
    }

    try {
      return fs
        .readdirSync(publicDirPath, { withFileTypes: true })
        .map((entry: any) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }));
    } catch (error) {
      console.warn(`Failed to read public directory: ${error}`);
      return [];
    }
  }

  /**
   * Verify that the .next directory contains all required files for a successful build
   */
  private verifyBuildOutput(): void {
    if (!this.nextOutputPath) {
      // Skip verification when output path is not available
      return;
    }

    // For standalone builds, check the standalone directory structure
    const standaloneDir = join(this.nextOutputPath, "standalone");
    const packageName = basename(
      join(this.props.buildDirectory, this.relativePathToPackage),
    );
    const standalonePackageDir = join(standaloneDir, packageName);

    if (existsSync(standaloneDir) && existsSync(standalonePackageDir)) {
      // Standalone build verification
      const requiredFiles = ["server.js", "package.json"];
      const requiredDirectories = [".next"];

      // Check required files in standalone package directory
      for (const file of requiredFiles) {
        const filePath = join(standalonePackageDir, file);
        if (!existsSync(filePath)) {
          throw new Error(
            `Required standalone build file missing: ${filePath}. Ensure Next.js build completed successfully with output: 'standalone'.`,
          );
        }
      }

      // Check required directories in standalone package directory
      for (const dir of requiredDirectories) {
        const dirPath = join(standalonePackageDir, dir);
        if (!existsSync(dirPath)) {
          throw new Error(
            `Required standalone build directory missing: ${dirPath}. Ensure Next.js build completed successfully.`,
          );
        }
      }
    } else {
      // Regular build verification (fallback)
      const requiredFiles = ["BUILD_ID", "package.json"];
      const requiredDirectories = ["static", "server"];

      // Check required files
      for (const file of requiredFiles) {
        const filePath = join(this.nextOutputPath, file);
        if (!existsSync(filePath)) {
          throw new Error(
            `Required build file missing: ${filePath}. Ensure Next.js build completed successfully.`,
          );
        }
      }

      // Check required directories
      for (const dir of requiredDirectories) {
        const dirPath = join(this.nextOutputPath, dir);
        if (!existsSync(dirPath)) {
          throw new Error(
            `Required build directory missing: ${dirPath}. Ensure Next.js build completed successfully.`,
          );
        }
      }
    }

    // Verify standalone output configuration
    const standaloneOutputDir = join(this.nextOutputPath, "standalone");
    if (!existsSync(standaloneOutputDir)) {
      console.warn(
        "Warning: .next/standalone directory not found. This indicates the build was not configured for standalone output. " +
          "Please ensure your next.config.js includes 'output: \"standalone\"' for optimal deployment performance.",
      );
    }

    console.log("Build output verification completed successfully.");
  }
}
