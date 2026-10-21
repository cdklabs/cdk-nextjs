import { rmSync } from "node:fs";
import * as cxapi from "aws-cdk-lib/cx-api";
import { Construct } from "constructs";

/**
 * Remove temporary directories that were handed to `Source.asset`, once the
 * `BucketDeployment`s reading them exist (or one of them failed).
 *
 * `Source.asset` stages during `BucketDeployment`'s construction - CDK's
 * `AssetStaging` copies into `cdk.out` from its own constructor - so the
 * temporary copies are dead the moment that returns. Left behind, every synth
 * would add another full copy to the system temp directory.
 *
 * Unless staging is disabled (`cdk synth --no-staging`, and SAM, which sets the
 * same context): then nothing is copied into `cdk.out`, the asset manifest
 * points at these directories themselves, and removing them would fail the
 * publish that follows the synth with ENOENT.
 */
export function removeStagingDirs(scope: Construct, dirs: string[]): void {
  if (scope.node.tryGetContext(cxapi.DISABLE_ASSET_STAGING_CONTEXT)) {
    return;
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}
