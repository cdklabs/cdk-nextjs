/**
 * API Gateway REQUEST authorizer admitting only requests that carry
 * `cdk-nextjs=1`, the cookie the regional-containers example's ALB requires.
 * Basic auth only for demo app; see `#createCookieAuthorizer` in `../app.ts`.
 */
const { REQUIRED_COOKIE } = process.env; // unset denies every request

export async function handler(event) {
  // HTTP/2 clients may split cookies across several `cookie` headers
  const cookies = Object.entries(event.multiValueHeaders ?? {})
    .filter(([name]) => name.toLowerCase() === "cookie")
    .flatMap(([, values]) => values)
    .flatMap((value) => value.split(";"))
    .map((cookie) => cookie.trim());
  if (!cookies.includes(REQUIRED_COOKIE)) {
    throw new Error("Unauthorized"); // API Gateway answers 401
  }
  // The whole stage, not `event.methodArn`: API Gateway caches this policy by
  // `Cookie` header and reuses it on every route, so a one-route ARN 403s the rest.
  const [apiArn, stage] = event.methodArn.split("/");
  return {
    principalId: "cdk-nextjs",
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: "Allow",
          Resource: `${apiArn}/${stage}/*`,
        },
      ],
    },
  };
}
