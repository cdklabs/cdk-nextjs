import { Runtime, RuntimeFamily } from "aws-cdk-lib/aws-lambda";

/**
 * The Lambda runtime of every function cdk-nextjs creates. Keep its major in
 * step with `nodeVersion` in `.projenrc.ts` (the generated custom-resource
 * functions and the runtime bundles' esbuild target) and the `node:<major>-alpine`
 * base of the generated Dockerfiles. A string rather than `Runtime.NODEJS_26_X`
 * so the `aws-cdk-lib` peer floor doesn't have to rise with it.
 *
 * Its own module, not `constants.ts`: the runtime and adapter bundles import
 * `constants.ts`, and this module-scope `new Runtime` would pull `aws-cdk-lib`
 * into every one of them.
 */
export const LAMBDA_RUNTIME = new Runtime("nodejs26.x", RuntimeFamily.NODEJS);
