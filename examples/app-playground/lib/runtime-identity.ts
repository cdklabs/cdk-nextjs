import { NextResponse } from 'next/server';

const INSTANCE_ID = Symbol.for('app-playground.instance-id');

/**
 * Which compute *instance* - one Lambda execution environment, one Fargate task
 * - is running this code. `computeId` names the function, which every instance
 * of it shares; the `use-cache` e2e needs to tell instances apart to show a
 * cache entry is shared between them rather than per process.
 *
 * Lambda's log stream is one per execution environment, and the ECS metadata URI
 * embeds the task. Anything else (`next start`) gets a random id per process,
 * kept on `globalThis` so every route bundle in the process reports the same one.
 */
export function instanceId(): string {
  const global = globalThis as { [INSTANCE_ID]?: string };
  global[INSTANCE_ID] ??=
    process.env['AWS_LAMBDA_LOG_STREAM_NAME'] ??
    process.env['ECS_CONTAINER_METADATA_URI_V4'] ??
    `process-${crypto.randomUUID()}`;
  return global[INSTANCE_ID];
}

/**
 * Which Lambda function is running this code, or `null` outside Lambda.
 *
 * An Event Function has `AWS_LAMBDA_FUNCTION_NAME`. A Web Function does not
 * (measured on a `NextjsGlobalWebFunctions` deploy), but each one has its own
 * endpoint, and the `host` it receives is that endpoint's domain. Only trusted
 * with `lambda-web-endpoint-name` present, which Lambda sets and strips from
 * client requests, so the request did come through a Web Function endpoint.
 */
function computeId(request: Request): string | null {
  const functionName = process.env['AWS_LAMBDA_FUNCTION_NAME'];
  if (functionName) return functionName;
  if (request.headers.has('lambda-web-endpoint-name')) {
    return request.headers.get('host');
  }
  return null;
}

/**
 * Reports which compute instance served the request. Used by the
 * `function-groups` e2e test to prove that two routes in different
 * `functionGroups` are served by *different* Lambda functions - the whole point
 * of splitting. Both `/runtime-identity` and `/api/runtime-identity` return
 * this, so a split that puts `/api/**` in its own group shows up as two
 * different `computeId`s.
 */
export function runtimeIdentity(request: Request) {
  return NextResponse.json(
    {
      // Set by cdk-nextjs on every function it creates, to the group name.
      functionGroup: process.env['CDK_NEXTJS_FUNCTION_GROUP'] ?? null,
      // Unique per Lambda function (null outside Lambda).
      computeId: computeId(request),
      instanceId: instanceId(),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
