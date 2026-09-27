import { Architecture } from "aws-cdk-lib/aws-lambda";

/**
 * Host architecture normalized to the two Lambda supports, spelled the way
 * Sharp's `@img/sharp-<platform>-<arch>` packages spell it.
 */
export function getNodeArchitecture(): string {
  return process.arch.startsWith("arm") ? "arm64" : "x64";
}

/**
 * The host's architecture as a Lambda one: the Functions types' default, so
 * any native dependency `next build` traced from this machine runs as built.
 */
export function getLambdaArchitecture(): Architecture {
  return getNodeArchitecture() === "arm64"
    ? Architecture.ARM_64
    : Architecture.X86_64;
}

/**
 * `architecture` spelled the way Sharp's `@img/sharp-<platform>-<arch>`
 * packages spell it.
 */
export function toNodeArchitecture(architecture: Architecture): string {
  return architecture.name === Architecture.ARM_64.name ? "arm64" : "x64";
}
