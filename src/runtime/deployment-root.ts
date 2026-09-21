import { basename, dirname } from "node:path";
import { RUNTIME_DIR_NAME } from "./manifest";

/**
 * The deployment root, derived from where the running shell sits.
 *
 * Synth copies the bundled shells and `manifest.json` into
 * `<deploymentRoot>/${RUNTIME_DIR_NAME}/`, so the root is this file's parent's
 * parent. Derived rather than read from `LAMBDA_TASK_ROOT` or the image
 * `WORKDIR`, so that both shells agree and a consumer overriding `WORKDIR` in
 * their own Dockerfile cannot break path resolution.
 *
 * @param shellDir the directory the calling shell was loaded from
 * (`dirname(fileURLToPath(import.meta.url))`).
 */
export function deploymentRootOf(shellDir: string): string {
  if (basename(shellDir) !== RUNTIME_DIR_NAME) {
    // A synth-side packaging mistake. Caught here because the alternative
    // symptom is "manifest.json not found" one directory away from the truth.
    throw new Error(
      `The cdk-nextjs runtime expected to be deployed at ` +
        `<deploymentRoot>/${RUNTIME_DIR_NAME}/ but is running from ` +
        `"${shellDir}". Every manifest path resolves against the deployment ` +
        `root, so it cannot be inferred from anywhere else.`,
    );
  }
  return dirname(shellDir);
}
