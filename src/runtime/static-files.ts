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
import { extname, join } from "node:path";
import type { ShimIncomingMessage } from "./http/request";
import { asServerResponse, ShimServerResponse } from "./http/response";
import { nextModule } from "./next-modules";

const SERVE_STATIC = "next/dist/server/serve-static.js";
type ServeStaticModule = typeof import("next/dist/server/serve-static.js");

/** Resolved on the first static-file request; see {@link nextModule}. */
let serveStaticModule: ServeStaticModule | undefined;

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
  serveStaticModule ??= nextModule<ServeStaticModule>(SERVE_STATIC);
  const { serveStatic, getContentType } = serveStaticModule;
  setBodyFileContentType(res, filePath, getContentType);
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
    const status = httpErrorStatus(error);
    // `send` emits its error before the first byte, so the head is still ours to
    // set; the guard is only for a shell that already committed one.
    if (status !== undefined && !res.headersSent) {
      res.statusCode = status;
      res.end();
      return true;
    }
    throw error;
  }
}

/**
 * The status a `send` error carries, for the errors that are the *client's*, not
 * ours.
 *
 * `serveStatic` is `send` underneath, and `send` rejects a failed precondition
 * with a 412 and an unsatisfiable `Range` with a 416 — both attached to the error
 * as `statusCode`. `next start` maps them back onto the response
 * (`next/dist/server/lib/router-server.js` special-cases 400/412/416); letting
 * them fall through to the caller's `failWith` instead turned
 * `If-Match: "stale"` into a 500 and `Range: bytes=99999-` into a 500.
 *
 * Only 4xx is honored: a 5xx from `send` is a real failure and belongs in the
 * error path, with the stack.
 */
function httpErrorStatus(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return status;
  }
  return undefined;
}

/**
 * `send` types a response from the file's own extension, and a static metadata
 * route ships as `<route>.body` — `robots.txt.body`, `manifest.webmanifest.body`,
 * `favicon.ico.body`. `.body` is not a media type, so every one of them would go
 * out as `application/octet-stream`.
 *
 * Next.js's adapter API is where the type is lost: `build-complete.ts` pushes
 * these through `isStaticMetadataFile()` as a bare `STATIC_FILE` — `id`,
 * `pathname`, `filePath`, and nothing else — while the headers the route handler
 * actually set sit unreferenced in a sibling `<route>.meta`. `next start` reads
 * that file through the response cache and answers `text/plain`.
 *
 * Stripping `.body` puts the route's own extension back on the end, which for
 * this population is the same answer: the set is closed (`favicon.ico`, `icon.*`,
 * `apple-icon.*`, `opengraph-image.*`, `twitter-image.*`, `sitemap.xml`,
 * `robots.txt`, `manifest.{json,webmanifest}`) and every member's type is implied
 * by its extension. `send` skips its own detection when `Content-Type` is already
 * set (`send/index.js`, `type()`), so this wins without reaching for `opts`.
 */
function setBodyFileContentType(
  res: ShimServerResponse,
  filePath: string,
  getContentType: ServeStaticModule["getContentType"],
): void {
  if (!filePath.endsWith(".body") || res.getHeader("Content-Type")) {
    return;
  }
  const ext = extname(filePath.slice(0, -".body".length)).slice(1);
  if (!ext) {
    return;
  }
  const contentType = getContentType(ext);
  if (contentType) {
    res.setHeader("Content-Type", contentType);
  }
}

function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // ENOENT covers a missing file and `send`'s "No directory access"; ENOTDIR is
  // what a path segment that exists as a file produces.
  return code === "ENOENT" || code === "ENOTDIR";
}
