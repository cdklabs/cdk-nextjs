/* eslint-disable import/no-extraneous-dependencies */
/**
 * Serving the static files that nothing in front of the compute answers.
 *
 * `NextjsStaticAssets` uploads `<distDir>/static` and `public` to S3, and
 * CloudFront / API Gateway route those prefixes there. Everything else in
 * `manifest.staticFiles` lives under `<distDir>/server` — `404.html`, `500.html`,
 * `favicon.ico.body`, fully-static Pages Router HTML — and reaches us, exactly as
 * it reaches `next start`.
 *
 * Next.js's own `serveStatic` is used rather than a `createReadStream`, because it
 * is `send` underneath and that brings conditional requests (`If-None-Match`,
 * `If-Modified-Since`), `Range`, `ETag`, `Last-Modified`, and content-type
 * detection. Reimplementing those is how a "simple" file server ends up
 * disagreeing with `next start` on a 304.
 */
import { join } from "node:path";
import { serveStatic } from "next/dist/server/serve-static.js";
import type { ShimIncomingMessage } from "./http/request";
import { asServerResponse, ShimServerResponse } from "./http/response";

/**
 * Returns `false` when the file is not in the deployment package, which is the
 * caller's cue to fall through to a 404.
 *
 * That happens by design for `<distDir>/static` and `public` paths: they are not
 * staged (they would be a second copy of bytes already in S3, and `public/` alone
 * can blow the 250 MB unzipped Lambda cap). Reaching this with one of those means
 * the distribution didn't route it to S3.
 */
export async function serveStaticFile(
  req: ShimIncomingMessage,
  res: ShimServerResponse,
  deploymentRoot: string,
  filePath: string,
): Promise<boolean> {
  try {
    await serveStatic(
      req as unknown as Parameters<typeof serveStatic>[0],
      asServerResponse(res),
      join(deploymentRoot, filePath),
    );
    return true;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // ENOENT covers a missing file and `send`'s "No directory access"; ENOTDIR is
  // what a path segment that exists as a file produces.
  return code === "ENOENT" || code === "ENOTDIR";
}
