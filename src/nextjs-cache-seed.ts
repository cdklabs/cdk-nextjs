import { join } from "node:path";
import { CustomResource, Duration } from "aws-cdk-lib";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  Runtime,
  RuntimeFamily,
} from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { OptionalCacheSeedCustomResourceProperties } from "./generated-structs/OptionalCacheSeedCustomResourceProperties";
import { OptionalCustomResourceProps } from "./generated-structs/OptionalCustomResourceProps";
import { OptionalFunctionProps } from "./generated-structs/OptionalFunctionProps";

export interface NextjsCacheSeedOverrides {
  readonly functionProps?: OptionalFunctionProps;
  readonly customResourceProps?: OptionalCustomResourceProps;
  readonly customResourceProperties?: OptionalCacheSeedCustomResourceProperties;
}

export interface NextjsCacheSeedProps {
  readonly buildId: string;
  readonly cacheBucket: IBucket;
  readonly debug?: boolean;
  readonly overrides?: NextjsCacheSeedOverrides;
}

export interface CacheSeedCustomResourceProperties {
  /**
   * Build whose init cache is copied from `_seed/<buildId>/` into
   * `<buildId>/`. Changes every build, so the resource runs on every deploy.
   */
  readonly buildId: string;
  readonly cacheBucketName: string;
}

/**
 * Copies the init cache, which `NextjsCache` uploads to `_seed/<buildId>/`,
 * into the live `<buildId>/` prefix the cache handler reads and writes.
 *
 * The copy happens once per build: it is skipped entirely once
 * `<buildId>/.seeded` exists, and each object is only copied if the key is
 * still absent. A CloudFormation rollback re-runs the previous build's seeding
 * (cdklabs/cdk-nextjs#343); with the upload going straight to `<buildId>/` that
 * overwrote every entry the app had regenerated or deleted since with its
 * build-time version. Now the rollback rewrites only the `_seed/` copy, which
 * nothing serves from, and this is a no-op.
 *
 * The compute depends on this resource, so a new build only takes traffic once
 * its cache is seeded: a request it served first would render on demand, and
 * that entry would then win over the seed.
 *
 * `cdk deploy --hotswap` never runs custom resources, so a hotswapped stack's
 * seed stays in `_seed/` until the next full deploy, or until this resource's
 * Lambda is invoked directly with `{ "buildId": "..." }`.
 */
export class NextjsCacheSeed extends Construct {
  customResource: CustomResource;
  lambdaFunction: LambdaFunction;

  private props: NextjsCacheSeedProps;

  constructor(scope: Construct, id: string, props: NextjsCacheSeedProps) {
    super(scope, id);
    this.props = props;
    this.lambdaFunction = this.createFunction();
    this.customResource = this.createCustomResource();
  }

  private createFunction() {
    const fn = new LambdaFunction(this, "Fn", {
      // Plain bundled JS with no native dependencies, so always arm64.
      architecture: Architecture.ARM_64,
      code: Code.fromAsset(
        join(__dirname, "../assets/lambdas/cache-seed/cache-seed.lambda"),
      ),
      handler: "index.handler",
      // Server-side copies, 32 at a time: memory only buys the CPU to keep
      // that many requests in flight.
      memorySize: 512,
      runtime: new Runtime("nodejs24.x", RuntimeFamily.NODEJS),
      // The most Lambda allows. The handler stops 30 s short of it and reports
      // FAILED, and a retry skips what was already copied.
      timeout: Duration.minutes(15),
      ...this.props.overrides?.functionProps,
    });
    // After the overrides, so an `environment` override can't drop it: a
    // direct invoke (after a hotswap) has no other way to find the bucket.
    fn.addEnvironment("CACHE_BUCKET_NAME", this.props.cacheBucket.bucketName);
    if (this.props.debug !== false) {
      // A `debug` namespace pattern; `1` matches no namespace and enables nothing.
      fn.addEnvironment("DEBUG", "cdk-nextjs:*");
    }
    // Read for the seed objects, the marker's HeadObject and the conditional
    // copy; list for `_seed/<buildId>/`; put for the copies and the marker.
    // Nothing is ever deleted.
    this.props.cacheBucket.grantRead(fn);
    this.props.cacheBucket.grantPut(fn);
    return fn;
  }

  private createCustomResource() {
    const properties: CacheSeedCustomResourceProperties = {
      buildId: this.props.buildId,
      cacheBucketName: this.props.cacheBucket.bucketName,
      ...this.props.overrides?.customResourceProperties,
    };
    return new CustomResource(this, "CustomResource", {
      properties,
      resourceType: "Custom::NextjsCacheSeed",
      serviceToken: this.lambdaFunction.functionArn,
      ...this.props.overrides?.customResourceProps,
    });
  }
}
