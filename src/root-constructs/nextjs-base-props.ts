export interface NextjsBaseProps {
  /**
   * Command to generate optimized version of your Next.js app in container;
   * @default "npm run build"
   */
  readonly buildCommand?: string;
  /**
   * [Build context](https://docs.docker.com/build/building/context/) for
   * `docker build`. This directory should contain your lockfile (i.e.
   * pnpm-lock.yaml) for your Next.js app. If you're not in a monorepo, then
   * this will be the same directory as your Next.js app. If you are in a
   * monorepo, then this value should be the root of your monorepo. You then
   * must pass the relative path to your Next.js app via {@link NextjsBaseProps.relativePathToPackage}
   *
   * Note, by default cdk-nextjs' `builder.Dockerfile` is used to build your
   * Next.js app. You can customize this by specifying `overrides.{nextjs...}.nextjsBuildProps.builderImageProps.file`.
   * If you override the default, then you are responsible for ensuring the
   * Dockerfile is in the build context directory before cdk-nextjs construct
   * is instantiated.
   * @example join(import.meta.dirname, "..") (monorepo)
   */
  readonly buildContext: string;
  /**
   * Path to API Route Handler that returns HTTP 200 to ensure compute health.
   * @example "/api/health"
   * @example
   * // api/health/route.ts
   * import { NextResponse } from "next/server";
   *
   * export function GET() {
   *   return NextResponse.json("");
   * }
   */
  readonly healthCheckPath: string;
  /**
   * Use this if building in monorepo. This is the relative path from
   * {@link NextjsBaseProps.buildContext} or root workspace to nested package
   * containing Next.js app. See example below:
   *
   * Let's say you have a monorepo with the following folder structure:
   * - my-monorepo/
   *   - packages/
   *     - ui/
   *       - package.json (nested)
   *   - package.json (root)
   *
   * And your Next.js app directory is the ui folder. Then you would set {@link NextjsBaseProps.buildContext}
   * to `"/absolute/path/to/my-monorepo"` and {@link NextjsBaseProps.relativePathToPackage}
   * to `"./packages/ui"`.
   *
   * Note, setting {@link NextjsBaseProps.buildContext} to the root of your
   * monorepo will invalidate container runtime (i.e. docker) build cache when any file is
   * changed in your monorepo. This is slows down deployments. Checkout how you
   * can use [turbo](https://turbo.build/) in [Deploying with Docker Guide](https://turbo.build/repo/docs/handbook/deploying-with-docker)
   * in the cdk-nextjs/examples/turbo.
   *
   * @example "./packages/ui"
   */
  readonly relativePathToPackage?: string;
  /**
   * @deprecated use relativePathToPackage
   */
  readonly relativePathToWorkspace?: string;
}
