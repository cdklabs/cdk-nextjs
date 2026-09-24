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
  if (
    basePath &&
    unstripped &&
    (unstripped === basePath || unstripped.startsWith(`${basePath}/`))
  ) {
    return unstripped;
  }
  return event.path;
}
