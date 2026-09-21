import { NextResponse } from 'next/server';

/**
 * Reports which compute instance served the request. Used by the
 * `function-groups` e2e test to prove that two routes in different
 * `functionGroups` are served by *different* Lambda functions - the whole point
 * of splitting. Both `/runtime-identity` and `/api/runtime-identity` return
 * this, so a split that puts `/api/**` in its own group shows up as two
 * different `computeId`s.
 */
export function runtimeIdentity() {
  return NextResponse.json(
    {
      // Set by cdk-nextjs on every function it creates, to the group name.
      functionGroup: process.env['CDK_NEXTJS_FUNCTION_GROUP'] ?? null,
      // Unique per Lambda function (undefined outside Lambda).
      computeId: process.env['AWS_LAMBDA_FUNCTION_NAME'] ?? null,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
