import { Architecture } from "aws-cdk-lib/aws-lambda";

export function getLambdaArchitecture(): Architecture {
  return process.arch === "x64" ? Architecture.X86_64 : Architecture.ARM_64;
}
