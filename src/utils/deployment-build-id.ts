/**
 * The build ID cdk-nextjs stores a deployment under. Pure, so the adapter can
 * check it at build time against the same format the constructs deploy with.
 */

/** {@link NextjsBuild.buildId}: Next.js's build ID, suffixed with the app's `deploymentId`. */
export function deploymentBuildId(manifest: {
  readonly buildId: string;
  readonly config: { readonly deploymentId: string };
}): string {
  const { deploymentId } = manifest.config;
  return deploymentId
    ? `${manifest.buildId}-${deploymentId}`
    : manifest.buildId;
}
