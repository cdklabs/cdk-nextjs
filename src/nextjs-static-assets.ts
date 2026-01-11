import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemovalPolicy } from "aws-cdk-lib";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  BucketProps,
} from "aws-cdk-lib/aws-s3";
import {
  BucketDeployment,
  BucketDeploymentProps,
  Source,
} from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export interface NextjsStaticAssetsOverrides {
  readonly bucketProps?: BucketProps;
  readonly bucketDeploymentProps?: BucketDeploymentProps;
}

export interface NextjsStaticAssetsProps {
  /**
   * Path to the local .next directory containing built assets
   */
  readonly buildOutputPath: string;
  /**
   * Build ID from NextjsBuild to track asset versions
   */
  readonly buildId: string;
  /**
   * Prefix to the URI path the app will be served at.
   * @example "/my-base-path"
   */
  readonly basePath?: string;
  readonly overrides?: NextjsStaticAssetsOverrides;
}

/**
 * Creates S3 Bucket for public and _next/static assets and deploys them using S3Deployment.
 */
export class NextjsStaticAssets extends Construct {
  bucket: Bucket;
  deployment: BucketDeployment;
  private stagingDir?: string;

  private props: NextjsStaticAssetsProps;

  constructor(scope: Construct, id: string, props: NextjsStaticAssetsProps) {
    super(scope, id);
    this.props = props;
    this.bucket = this.createBucket();
    this.deployment = this.createDeployment();
  }

  private createBucket() {
    return new Bucket(this, "Bucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      minimumTLSVersion: 1.2,
      ...this.props.overrides?.bucketProps,
    });
  }

  private createDeployment() {
    // Create a staging directory with the correct structure
    this.stagingDir = this.createStagingDirectory();

    if (!this.stagingDir) {
      // No assets to deploy - this is a valid scenario for some Next.js apps
      // Don't create a deployment at all
      throw new Error(
        `No static assets found to deploy. Ensure your Next.js build output contains either:
        - A 'public' directory at: ${join(this.props.buildOutputPath, "public")}
        - A '.next/static' directory at: ${join(this.props.buildOutputPath, ".next", "static")}
        
        If your app has no static assets, you may not need NextjsStaticAssets.`,
      );
    }

    const destinationKeyPrefix = this.props.basePath
      ? this.props.basePath.replace(/^\//, "")
      : undefined;

    return new BucketDeployment(this, "Deployment", {
      sources: [Source.asset(this.stagingDir)],
      destinationBucket: this.bucket,
      destinationKeyPrefix,
      // Add BUILD_ID as metadata to all objects for version tracking
      metadata: {
        BUILD_ID: this.props.buildId,
      },
      // S3Deployment automatically detects content types based on file extensions
      ...this.props.overrides?.bucketDeploymentProps,
    });
  }

  /**
   * Create a staging directory with the correct structure:
   * - public/ files go to root
   * - .next/static/ files go to _next/static/
   */
  private createStagingDirectory(): string | undefined {
    const stagingDir = mkdtempSync(join(tmpdir(), "nextjs-assets-"));
    let hasAssets = false;

    try {
      // Copy public directory contents to staging root
      const publicPath = join(this.props.buildOutputPath, "public");
      if (this.directoryExists(publicPath)) {
        this.copyDirectoryContents(publicPath, stagingDir);
        hasAssets = true;
      }

      // Copy .next/static to staging/_next/static
      const staticPath = join(this.props.buildOutputPath, ".next", "static");
      if (this.directoryExists(staticPath)) {
        const nextDir = join(stagingDir, "_next");
        const staticDestDir = join(nextDir, "static");

        // Create _next directory
        mkdirSync(nextDir, { recursive: true });

        // Copy static assets
        this.copyDirectoryContents(staticPath, staticDestDir);
        hasAssets = true;
      }

      return hasAssets ? stagingDir : undefined;
    } catch (error) {
      console.error("Error creating staging directory:", error);
      // Clean up on error
      try {
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      return undefined;
    }
  }

  /**
   * Copy directory contents recursively
   */
  private copyDirectoryContents(srcDir: string, destDir: string): void {
    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    const entries = readdirSync(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = join(srcDir, entry.name);
      const destPath = join(destDir, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectoryContents(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  /**
   * Check if a directory exists
   */
  private directoryExists(dirPath: string): boolean {
    try {
      return existsSync(dirPath) && statSync(dirPath).isDirectory();
    } catch {
      return false;
    }
  }
}
