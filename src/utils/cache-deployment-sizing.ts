/** What a `BucketDeployment` Lambda gets without asking. */
export const DEFAULT_EPHEMERAL_STORAGE_MIB = 512;
/** The most Lambda will give any function. */
export const MAX_EPHEMERAL_STORAGE_MIB = 10240;
/** Above this many MiB of init cache, the unzip Lambda gets more memory. */
const RAISED_MEMORY_THRESHOLD_MIB = 256;
/** The memory, in MB, a cache past that threshold gets. */
const RAISED_MEMORY_LIMIT_MB = 1024;

export interface DeploymentLambdaSizing {
  /** The init cache, in MiB, rounded up. */
  readonly cacheMib: number;
  /** `/tmp` to ask for: a {@link storageStep} at or above the budget. */
  readonly ephemeralStorageMib: number;
  /** Memory to ask for, or `undefined` to keep CDK's (and Lambda's) default. */
  readonly memoryLimit?: number;
  /** Whether the budget is past what Lambda can give, so the unzip will fail. */
  readonly exceedsMax: boolean;
}

/**
 * The smallest power-of-two MiB step at or above `mib`, capped at `max`.
 *
 * `BucketDeployment` folds `ephemeralStorageSize` into both its singleton
 * handler's UUID and its custom resource's logical ID, so every distinct size is
 * a new handler Lambda, a new `ServiceToken`, and a replaced custom resource.
 * Sized to the MiB, that was every deploy whose init cache grew by one: a full
 * CloudFormation deployment where a hotswap would have done. Doubling steps
 * change only when the cache does by a large fraction.
 */
export function storageStep(mib: number, max: number): number {
  let step = DEFAULT_EPHEMERAL_STORAGE_MIB;
  while (step < mib) {
    step *= 2;
  }
  return Math.min(step, max);
}

/**
 * Ephemeral storage and memory for the `BucketDeployment` Lambda that unpacks
 * an init cache of `bytes`.
 *
 * The zip's compressed size is not known at synth time, so the worst case — an
 * incompressible payload — is what gets budgeted: twice the cache, plus
 * 128 MiB of headroom, rounded up to a {@link storageStep}. Memory is only
 * raised for a cache over 256 MiB; smaller ones keep the default and their
 * existing template.
 */
export function deploymentLambdaSizing(bytes: number): DeploymentLambdaSizing {
  const cacheMib = Math.ceil(bytes / 1024 ** 2);
  const wanted = cacheMib * 2 + 128;
  return {
    cacheMib,
    ephemeralStorageMib: storageStep(wanted, MAX_EPHEMERAL_STORAGE_MIB),
    memoryLimit:
      cacheMib > RAISED_MEMORY_THRESHOLD_MIB
        ? RAISED_MEMORY_LIMIT_MB
        : undefined,
    exceedsMax: wanted > MAX_EPHEMERAL_STORAGE_MIB,
  };
}
