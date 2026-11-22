/** What a Lambda function gets without asking. */
export const DEFAULT_EPHEMERAL_STORAGE_MIB = 512;
/** The most Lambda will give any function. */
export const MAX_EPHEMERAL_STORAGE_MIB = 10240;
/** Room in `/tmp` past the zip itself. */
const HEADROOM_MIB = 128;
/** Memory, in MB, for a cache up to {@link RAISED_MEMORY_THRESHOLD_MIB}. */
const DEFAULT_MEMORY_MB = 512;
/** Above this many MiB of init cache, the seeder gets more memory. */
const RAISED_MEMORY_THRESHOLD_MIB = 256;
/** The memory, in MB, a cache past that threshold gets. */
const RAISED_MEMORY_MB = 1024;

export interface CacheSeedSizing {
  /** The init cache, in MiB, rounded up. */
  readonly cacheMib: number;
  /** `/tmp` to ask for: a {@link storageStep} at or above the budget. */
  readonly ephemeralStorageMib: number;
  readonly memoryMb: number;
  /** Whether the budget is past what Lambda can give, so the download may fail. */
  readonly exceedsMax: boolean;
}

/**
 * The smallest power-of-two MiB step at or above `mib`, capped at `max`.
 *
 * Sized to the MiB, every deploy whose init cache grew by one would change the
 * seeder's configuration, which `cdk deploy --hotswap` can't apply, and so fall
 * back to a full CloudFormation deployment. Doubling steps change only when the
 * cache does by a large fraction.
 */
export function storageStep(mib: number, max: number): number {
  let step = DEFAULT_EPHEMERAL_STORAGE_MIB;
  while (step < mib) {
    step *= 2;
  }
  return Math.min(step, max);
}

/**
 * Ephemeral storage and memory for the cache seeder, which downloads an init
 * cache of `bytes`, zipped, into `/tmp` and reads it from there.
 *
 * The zip's size is not known at synth time (CDK archives the asset when it
 * publishes it), so the worst case is what gets budgeted: a zip as large as
 * the cache, which deflate stays within by storing what it can't compress,
 * plus 128 MiB of headroom, rounded up to a {@link storageStep}. Memory, and
 * the CPU that comes with it, for inflating and putting 32 entries at a time,
 * is raised for a cache over 256 MiB.
 */
export function cacheSeedSizing(bytes: number): CacheSeedSizing {
  const cacheMib = Math.ceil(bytes / 1024 ** 2);
  const wanted = cacheMib + HEADROOM_MIB;
  return {
    cacheMib,
    ephemeralStorageMib: storageStep(wanted, MAX_EPHEMERAL_STORAGE_MIB),
    memoryMb:
      cacheMib > RAISED_MEMORY_THRESHOLD_MIB
        ? RAISED_MEMORY_MB
        : DEFAULT_MEMORY_MB,
    exceedsMax: wanted > MAX_EPHEMERAL_STORAGE_MIB,
  };
}
