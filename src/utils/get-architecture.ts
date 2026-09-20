import { Architecture } from "aws-cdk-lib/aws-lambda";

/**
 * Host architecture normalized to the two Lambda supports, spelled the way
 * Sharp's `@img/sharp-<platform>-<arch>` packages spell it.
 *
 * The Lambda's architecture and the Sharp binaries bundled into its asset must
 * come from this one value: deriving them separately lets them disagree on a
 * host that is neither x64 nor arm (e.g. s390x), which produces a Lambda that
 * fails to load its own bindings.
 */
export function getNodeArchitecture(): string {
  return process.arch.startsWith("arm") ? "arm64" : "x64";
}

export function getLambdaArchitecture(): Architecture {
  return getNodeArchitecture() === "arm64"
    ? Architecture.ARM_64
    : Architecture.X86_64;
}
