import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  IBucket,
} from "aws-cdk-lib/aws-s3";
import {
  BucketDeployment,
  BucketDeploymentProps,
  Source,
} from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import { LOG_PREFIX } from "./constants";

export interface NextjsStaticAssetsOverrides {
  readonly bucketProps?: BucketProps;
  readonly bucketDeploymentProps?: BucketDeploymentProps;
}

export interface NextjsStaticAssetsProps {
  /**
   * Bring your own S3 bucket for static assets. When provided, cdk-nextjs
   * will skip creating a new bucket and deploy assets to this bucket instead.
   * Use with `basePath` to isolate assets per branch when sharing a bucket.
   */
  readonly bucket?: IBucket;
  /**
   * Directory where the Next.js application is located.
   * This should contain the .next directory and other build artifacts.
   */
  readonly buildDirectory: string;
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
  bucket: IBucket;
  deployment: BucketDeployment;
  private stagingDir?: string;

  private props: NextjsStaticAssetsProps;

  constructor(scope: Construct, id: string, props: NextjsStaticAssetsProps) {
    super(scope, id);
    this.props = props;
    this.bucket = props.bucket ?? this.createBucket();
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
      throw new Error(
        `No static assets found to deploy. Ensure your Next.js build output contains either:
        - A 'public' directory at: ${join(this.props.buildDirectory, "public")}
        - A '.next/static' directory at: ${join(this.props.buildDirectory, ".next", "static")}`,
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
      prune: false, // Don't delete existing assets to prevent 404s during deployment, pruning will be handled by post-deploy
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
      const publicPath = join(this.props.buildDirectory, "public");
      if (this.directoryExists(publicPath)) {
        cpSync(publicPath, stagingDir, { recursive: true });
        hasAssets = true;
      }

      // Copy .next/static to staging/_next/static
      const staticPath = join(this.props.buildDirectory, ".next", "static");
      if (this.directoryExists(staticPath)) {
        const nextDir = join(stagingDir, "_next");
        const staticDestDir = join(nextDir, "static");

        // Create _next directory
        mkdirSync(nextDir, { recursive: true });

        // Copy static assets
        cpSync(staticPath, staticDestDir, { recursive: true });
        hasAssets = true;
      }

      return hasAssets ? stagingDir : undefined;
    } catch (error) {
      console.error(`${LOG_PREFIX} Error creating staging directory:`, error);
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
