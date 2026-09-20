/**
 * Undocumented, unsupported gates for work in progress.
 *
 * These are deliberately env vars rather than construct props: they select
 * between an existing code path and one that is still being built, so they
 * carry no JSII public surface to document, deprecate, or remove. Each one is
 * deleted in the PR that makes its new path the only path.
 *
 * Not part of this package's public API. Do not reference them from README or
 * `docs/`, and do not use them in a real deployment.
 */

/**
 * Serve `_next/image` from a dedicated image optimization Lambda
 * (`NextjsImageFunction`) instead of the Next.js server function, for the two
 * Functions `NextjsType`s.
 *
 * Off by default because the dedicated Lambda is not the Next.js server, so
 * Next.js middleware does not run for image requests — Next's default matcher
 * (`/:path*`) covers `/_next/image`. The adapter runtime release
 * (`docs/plans/adapter-runtime-release.md`) resolves that by dispatching
 * `_next/image` in-process after middleware, at which point the separate
 * Lambda and this flag both go away.
 */
export function useDedicatedImageFunction(): boolean {
  return process.env.CDK_NEXTJS_EXPERIMENTAL_DEDICATED_IMAGE_FUNCTION === "1";
}
