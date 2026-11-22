import { BucketDeploymentProps } from "aws-cdk-lib/aws-s3-deployment";
import { LOG_PREFIX } from "./constants";

/**
 * Why each rejectable `bucketDeploymentProps` override breaks a construct's
 * upload, or `undefined` to let it through.
 */
export interface RejectedDeploymentOverrides {
  readonly prune?: string;
  readonly retainOnDelete?: string;
  readonly extract?: string;
}

/**
 * Throws if `overrides` sets one of the `bucketDeploymentProps` values a
 * construct can't work with: `prune: true`, `retainOnDelete: false` or
 * `extract: false`, each checked only if `rejected` explains it.
 *
 * Compared against the exact value, so an explicit `undefined` from a JSII
 * binding is not mistaken for an override.
 */
export function rejectDeploymentOverrides(
  overrides: BucketDeploymentProps | undefined,
  rejected: RejectedDeploymentOverrides,
  reason: string,
): void {
  const found = [
    overrides?.prune === true &&
      rejected.prune !== undefined &&
      `\`prune: true\`${rejected.prune}`,
    overrides?.retainOnDelete === false &&
      rejected.retainOnDelete !== undefined &&
      `\`retainOnDelete: false\`${rejected.retainOnDelete}`,
    overrides?.extract === false &&
      rejected.extract !== undefined &&
      `\`extract: false\`${rejected.extract}`,
  ].filter((entry): entry is string => !!entry);
  if (found.length > 0) {
    throw new Error(
      `${LOG_PREFIX} overrides.bucketDeploymentProps can't set ${found.join(", or ")}: ${reason}`,
    );
  }
}
