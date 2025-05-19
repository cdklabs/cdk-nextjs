/**
 * Important in e2e test since we set ENV to PR number
 */
export function getStackName(stackName: string) {
  let env = process.env["ENV"] ?? "dev";
  if (!isNaN(Number(env))) {
    // cloudformation stacks must begin with string
    env = `pr-${env}`;
  }
  return `${env}-${stackName}`;
}
