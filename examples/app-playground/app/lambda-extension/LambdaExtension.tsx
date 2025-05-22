/**
 * Simple example of how to get parameter via AWS Lambda Parameters and Secrets Extension
 * @see https://docs.aws.amazon.com/systems-manager/latest/userguide/ps-integration-lambda-extensions.html
 */
export async function LambdaSsmParameterValue() {
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!sessionToken) {
    return 'Missing process.env.AWS_SESSION_TOKEN';
  }
  const response = await fetch(
    `http://localhost:2773/systemsmanager/parameters/get?name=/cdk-bootstrap/hnb659fds/version`,
    {
      headers: {
        'X-Aws-Parameters-Secrets-Token': sessionToken,
      },
    },
  );
  if (response.status !== 200) {
    return `Failed to get SSM Parameter: /cdk-bootstrap/hnb659fds/version. Did you deploy the cdk-nextjs/examples/turbo example which has a customized global-functions.Dockerfile that installs the AWS Lambda Parameters and Secrets Extension? Request failed with status ${response.status}`;
  }
  const parameter = await response.json();
  return parameter;
}
