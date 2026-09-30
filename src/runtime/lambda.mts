/* eslint-disable import/no-extraneous-dependencies */
/**
 * The Functions shell: a Lambda response-streaming handler around the runtime
 * core.
 *
 * Reached two ways, and both event shapes are handled here rather than being
 * normalized by the constructs:
 *
 * - **Global Functions** — a Lambda Function URL behind CloudFront, so a payload
 *   v2 `LambdaFunctionURLEvent` (`rawPath`, `rawQueryString`, `cookies`).
 * - **Regional Functions** — an API Gateway REST streaming proxy integration, so
 *   an `APIGatewayProxyEvent` (`path`, `multiValueQueryStringParameters`,
 *   `httpMethod`).
 *
 * Everything past `toRuntimeRequest` is shared with the container shell. This
 * file owns exactly two things Lambda-specific: the event shape, and the
 * `awslambda.HttpResponseStream` prelude.
 */
import { dirname } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { loadRuntime } from "./core";
import { deploymentRootOf } from "./deployment-root";
import type { ResponseHead } from "./http/response";
import type { ResponseSink } from "./http/sink";
import { LambdaEvent, toRuntimeRequest } from "./lambda-event";

/**
 * Loaded at module load so the manifest read, the `chdir`, and the routing-table
 * construction all happen during Lambda's init phase, which gets full CPU and is
 * not billed on a provisioned-concurrency or SnapStart-less cold start the way
 * handler time is. Awaited there too, so a failed load fails the init — Lambda
 * reports it and retries in a fresh sandbox — instead of being cached as a
 * rejected promise every invocation in this one would re-throw.
 */
const runtime = await loadRuntime(
  deploymentRootOf(dirname(fileURLToPath(import.meta.url))),
);

class LambdaResponseSink implements ResponseSink {
  /** See {@link ResponseSink.padEmptyBody}. Both integrations need it. */
  public readonly padEmptyBody = true;

  public constructor(private readonly responseStream: Writable) {}

  public begin(head: ResponseHead): Writable {
    // The prelude has to precede the first body byte, which is why
    // `ShimServerResponse` emits the head as an event instead of letting Next.js
    // write straight through.
    return awslambda.HttpResponseStream.from(this.responseStream, {
      statusCode: head.statusCode,
      headers: head.headers,
      cookies: head.cookies,
    });
  }
}

export const handler = awslambda.streamifyResponse(
  async (event: LambdaEvent, responseStream: Writable): Promise<void> => {
    await runtime.handle(
      toRuntimeRequest(event, runtime.manifest.config.basePath),
      new LambdaResponseSink(responseStream),
    );
  },
);
