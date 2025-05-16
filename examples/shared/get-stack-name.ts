/**
 * Important in e2e test since we set ENV to PR number
 */
export function getStackName(stackName: string) {
  const env = process.env["ENV"] ?? "dev";
  return `${env}-${stackName}`;
}
