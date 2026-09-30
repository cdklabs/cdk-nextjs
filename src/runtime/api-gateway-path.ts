import { hasPathPrefix } from "../utils/base-path";

/**
 * The path to hand Next.js for an API Gateway REST event.
 *
 * API Gateway strips the prefix it routed on before invoking Lambda: the stage on
 * the execute-api endpoint (`/prod/foo` arrives as `event.path = "/foo"`), or the
 * base path mapping on a custom domain. `requestContext.path` keeps it. Which of
 * the two is right depends on the app:
 *
 * - An app built with a `basePath` that *includes* the stripped prefix — the
 *   usual execute-api setup, `basePath: "/prod"` so its links carry the stage —
 *   only routes the unstripped path. Handing it `event.path` 404'd every request,
 *   which is why `examples/app-playground` used to carry a `proxy.ts` that
 *   prepended the stage from an environment variable.
 * - Every other app — no `basePath`, or one API Gateway does not strip (a custom
 *   domain mapped at the root) — routes `event.path`, and `requestContext.path`
 *   would carry a stage it never heard of.
 *
 * So `requestContext.path` is used exactly when it starts with the app's
 * `basePath` on a segment boundary, and nothing has to be configured: a stage
 * named `test`, a renamed stage and a base path mapping are all read off the
 * event. Measured against a deployed REST API: the two fields share an encoding
 * (`/a%20b` in both), and only `event.path` is normalized — `/prod` arrives as
 * `"/"` and `/prod//foo` as `"/foo"` — so reconstructing the prefix from their
 * difference is not reliable, and taking `requestContext.path` whole is.
 *
 * @param basePath the app's own `basePath`, as the adapter manifest records it:
 * `""` or a leading-slash path with no trailing slash.
 */
export function apiGatewayRequestPath(
  event: { path: string; requestContext: { path?: string } },
  basePath: string,
): string {
  const unstripped = event.requestContext.path;
  if (unstripped && hasPathPrefix(unstripped, basePath)) {
    return unstripped;
  }
  return (
    (unstripped && withRepeatedSlashes(unstripped, event.path)) ?? event.path
  );
}

/**
 * `event.path` with the repeated slashes API Gateway collapsed put back, or
 * `undefined` when there are none to restore.
 *
 * `//` arrives as `event.path = "/"`, so Next.js never sees the repeated slash it
 * redirects away (`normalizeRepeatedSlashes`), and the page is served at `//`
 * itself - where the Pages Router's client throws `Invalid URL` building a URL
 * from a protocol-relative path, and the page never hydrates. Found by next.js's
 * `test/e2e/hydration` on Regional Functions.
 *
 * The prefix API Gateway stripped (the stage, or a base path mapping) is not
 * recoverable by subtracting one field from the other, for the reason above.
 * So whole leading segments are dropped from `requestContext.path` until what is
 * left, collapsed, is `event.path`: the first such suffix is the unstripped path
 * below the prefix. If none matches, `event.path` stands.
 */
function withRepeatedSlashes(
  unstripped: string,
  stripped: string,
): string | undefined {
  if (!unstripped.includes("//")) {
    return undefined;
  }
  for (let rest = unstripped; ;) {
    if (rest.replace(/\/{2,}/g, "/") === stripped) {
      return rest === stripped ? undefined : rest;
    }
    const next = rest.replace(/^\/[^/]+/, "");
    if (next === rest) {
      return undefined;
    }
    rest = next;
  }
}
