import { Architecture } from "aws-cdk-lib/aws-lambda";

/**
 * The host's architecture as a Lambda one: the Functions types' default, so
 * any native dependency `next build` traced from this machine runs as built.
 */
export function getLambdaArchitecture(): Architecture {
  return process.arch.startsWith("arm")
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
