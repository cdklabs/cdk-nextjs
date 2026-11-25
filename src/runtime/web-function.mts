/**
 * The Web Functions shell: the container shell's `node:http` server, listening
 * where Lambda Web Functions tell it to.
 *
 * Same server, same translation into a {@link RuntimeRequest}, as
 * `server.mts`, so a request is handled exactly as on Containers. Three things
 * differ, all from how Lambda runs it:
 *
 * - It binds `AWS_LAMBDA_HTTP_ENDPOINT` (`host:port`), not `PORT`/`HOSTNAME`.
 * - It listens before the runtime has loaded, since Lambda fails an environment
 *   whose server isn't listening within 10 seconds. Requests that arrive first
 *   wait for the load.
 * - It trusts `x-forwarded-host` on requests through the IAM-authorized
 *   endpoint, where CloudFront's viewer-request function set it, since Lambda
 *   replaces `Host` with the endpoint's own domain; see `isTrustedEndpoint`.
 *
 * @see https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntime } from "./core";
import { deploymentRootOf } from "./deployment-root";
import { createRuntimeServer } from "./http/node-server";
import {
  isTrustedEndpoint,
  listenAddress,
  TRUSTED_ENDPOINT_ENV_VAR,
} from "./web-function-env";

/**
 * Lambda gives the process 1 second after `SIGTERM`, by which time it has
 * already stopped routing requests here and let in-flight ones finish. Exit a
 * little before, so the exit is ours.
 * @see https://docs.aws.amazon.com/lambda/latest/dg/web-functions-env-lifecycle.html
 */
const SHUTDOWN_GRACE_MS = 900;

const { host, port } = listenAddress(process.env.AWS_LAMBDA_HTTP_ENDPOINT);
const trustedEndpoint = process.env[TRUSTED_ENDPOINT_ENV_VAR];

const runtime = loadRuntime(
  deploymentRootOf(dirname(fileURLToPath(import.meta.url))),
);
// A failed load can't serve anything, and a rejected promise cached here would
// fail every request this environment gets. Exiting has Lambda replace it.
runtime.catch((error: unknown) => {
  console.error("cdk-nextjs runtime failed to load:", error);
  process.exit(1);
});

const { server, shutdown } = createRuntimeServer(
  { handle: async (request, sink) => (await runtime).handle(request, sink) },
  {
    // The endpoint is HTTPS only, so a URL the app builds is `https://` unless
    // `x-forwarded-proto` says otherwise.
    encrypted: true,
    trustForwardedHost: (headers) =>
      isTrustedEndpoint(headers, trustedEndpoint),
  },
);

let draining = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (draining) {
      return;
    }
    draining = true;
    console.log(`Received ${signal}, draining.`);
    // `waitUntil` work still running (ISR revalidation) gets what is left of
    // the grace period; see `RuntimeServer.shutdown`.
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    void shutdown().then(() => process.exit(0));
  });
}

server.listen(port, host, () => {
  console.log(`cdk-nextjs runtime listening on ${host}:${port}`);
});
