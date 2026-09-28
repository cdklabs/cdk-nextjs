/**
 * The Containers shell: a `node:http` server around the runtime core.
 *
 * Replaces the `server.js` that `output: "standalone"` used to generate. Note
 * what it does *not* do: it does not hand Next.js the real `IncomingMessage` /
 * `ServerResponse` it was given. Those are translated into a
 * {@link RuntimeRequest} and a {@link ResponseSink}, exactly as the Lambda shell
 * does, so the container e2e suite exercises the code Lambda runs. Handing
 * Containers real `node:http` objects would make those tests prove nothing about
 * Functions — which is how the previous implementation's Lambda-only bugs got
 * past a green container suite.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRuntime } from "./core";
import { deploymentRootOf } from "./deployment-root";
import { createRuntimeServer } from "./http/node-server";

const PORT = Number(process.env.PORT ?? 3000);
/** ECS tasks must bind every interface to be reachable by the ALB. */
const HOSTNAME = process.env.HOSTNAME ?? "0.0.0.0";

async function main(): Promise<void> {
  const runtime = await loadRuntime(
    deploymentRootOf(dirname(fileURLToPath(import.meta.url))),
  );
  const { server, shutdown } = createRuntimeServer(runtime);

  // ECS sends SIGTERM and waits `stopTimeout` before SIGKILL. Without this the
  // process exits immediately and every in-flight response is truncated during
  // an ordinary deployment; see `RuntimeServer.shutdown` for what it waits on.
  let draining = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (draining) {
        return;
      }
      draining = true;
      console.log(`Received ${signal}, draining connections.`);
      void shutdown().then(() => process.exit(0));
    });
  }

  server.listen(PORT, HOSTNAME, () => {
    console.log(`cdk-nextjs runtime listening on ${HOSTNAME}:${PORT}`);
  });
}

void main();
