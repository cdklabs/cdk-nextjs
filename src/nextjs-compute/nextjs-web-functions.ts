import { writeFileSync } from "node:fs";
import { posix } from "node:path";
import { Duration } from "aws-cdk-lib";
import {
  IRole,
  ManagedPolicy,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  WebFunction,
  WebFunctionAuthType,
  WebFunctionCode,
  WebFunctionEndpoint,
  WebFunctionEndpointLocation,
  WebFunctionEndpointType,
  WebFunctionProps,
  WebFunctionRuntime,
} from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import {
  grantRuntimeAccess,
  NextjsComputeBaseProps,
  runtimeEnvironment,
} from "./nextjs-compute-base-props";
import { DEFAULT_FUNCTION_GROUP } from "../adapter/function-groups";
import { LOG_PREFIX } from "../constants";
import { OptionalWebFunctionProps } from "../generated-structs/OptionalWebFunctionProps";
import { NextjsDeploymentRoot } from "../nextjs-build/nextjs-build";
import { FUNCTION_GROUP_ENV_VAR, RUNTIME_DIR_NAME } from "../runtime/manifest";
import { TRUSTED_ENDPOINT_ENV_VAR } from "../runtime/web-function-env";
import { zipDirectory } from "../utils/zip-directory";

/**
 * The shell every Web Function runs, relative to its deployment root.
 * @see NextjsBuild.relativePathToEntrypoint
 */
const ENTRY_POINT = posix.join(RUNTIME_DIR_NAME, "web-function.mjs");

/**
 * What the L2 names a home-Region default endpoint it isn't given a name for.
 * Set explicitly so the runtime can be told the name at synth, before the
 * endpoint exists; see {@link TRUSTED_ENDPOINT_ENV_VAR}.
 */
const DEFAULT_ENDPOINT_NAME = "prod";

export interface NextjsWebFunctionsOverrides {
  /**
   * Props for the Web Function, with its default endpoint's settings under
   * `defaultEndpoint`, as on the `WebFunction` construct.
   *
   * Construct-wide (`NextjsWebFunctionsProps.overrides`), these apply to every
   * function group's Web Function, except the props that identify one
   * function: `webFunctionName`, `code` and `entryPoint` apply to the `default`
   * group only, as on `NextjsFunctionsOverrides.functionProps`. Set those per
   * group, in the group's own `overrides`.
   *
   * Two props can't be changed, since CloudFront could no longer reach the
   * function safely: `defaultEndpointAuth` stays `IAM_AUTH`, and
   * `defaultEndpoint.endpointLocation` stays `homeRegion()`. Synth fails on
   * an override that asks for anything else.
   */
  readonly webFunctionProps?: OptionalWebFunctionProps;
}

/**
 * A set of routes to package into their own Web Function. The same pattern
 * grammar and limits as `NextjsFunctionGroup`; only the overrides differ.
 *
 * A Web Function's package can be 512 MB unzipped, twice an Event Function's,
 * and memory is fixed at 2 GB, so a group is rarely needed for size and can't
 * be sized differently. Its overrides can still give it its own timeout,
 * concurrency per environment or environment variables.
 * @see NextjsFunctionGroup
 */
export interface NextjsWebFunctionGroup {
  /**
   * Group name. Becomes a construct id and part of the Web Function name, so
   * it must match `/^[a-zA-Z0-9-]+$/`. `default` is reserved.
   */
  readonly name: string;
  /** Path patterns this group owns; see `NextjsFunctionGroup`. */
  readonly routes: string[];
  /** Per-group overrides, merged over the construct-wide `overrides`. */
  readonly overrides?: NextjsWebFunctionsOverrides;
}

/** One deployed function group: its Web Function, its endpoint, its routes. */
export interface NextjsWebFunctionGroupResources {
  /** Group name; `default` for the implicit catch-all group. */
  readonly name: string;
  /**
   * Route templates packaged into this function, as the adapter assigned them.
   * Empty for the default group is normal in a heavily split app.
   */
  readonly routes: string[];
  readonly webFunction: WebFunction;
  /** The IAM-authorized endpoint CloudFront reaches the function through. */
  readonly endpoint: WebFunctionEndpoint;
  /** The Web Function's execution role. */
  readonly role: IRole;
}

export interface NextjsWebFunctionsProps extends NextjsComputeBaseProps {
  readonly overrides?: NextjsWebFunctionsOverrides;
  /**
   * The staged deployment roots, one per function group, `default` among them.
   * @see NextjsBuild.deploymentRoots
   */
  readonly deploymentRoots: NextjsDeploymentRoot[];
  /**
   * Per-group configuration, keyed by name against {@link deploymentRoots}.
   * Routes come from the build; this only carries `overrides`.
   */
  readonly functionGroups?: NextjsWebFunctionGroup[];
}

/**
 * Run Next.js on AWS Lambda Web Functions.
 *
 * Each function runs cdk-nextjs's own HTTP server shell
 * (`cdk-nextjs-runtime/web-function.mjs`) around the entrypoints `next build`
 * produced, serving up to `maxConcurrencyPerEnvironment` requests at once per
 * execution environment. The function's default endpoint is `IAM_AUTH` and in
 * the stack's Region; nothing is reachable without a SigV4 signature, which
 * `NextjsDistribution` has CloudFront's Origin Access Control add.
 *
 * The code is staged with `WebFunctionCode.fromAssetToManagedBucket`: Lambda
 * reads it at runtime as its service principal, which the CDK bootstrap bucket
 * doesn't allow.
 * @see https://docs.aws.amazon.com/lambda/latest/dg/web-functions.html
 */
export class NextjsWebFunctions extends Construct {
  /**
   * The `default` group's Web Function: the one the distribution's default
   * behavior targets, and the only one unless `functionGroups` is used.
   */
  webFunction: WebFunction;
  /** The `default` group's endpoint. */
  endpoint: WebFunctionEndpoint;
  /**
   * Every deployed group, `default` first. Iterate this rather than
   * {@link webFunction} for anything that must reach all of them.
   */
  functionGroups: NextjsWebFunctionGroupResources[];

  private props: NextjsWebFunctionsProps;

  constructor(scope: Construct, id: string, props: NextjsWebFunctionsProps) {
    super(scope, id);
    this.props = props;

    const roots = props.deploymentRoots;
    this.functionGroups = roots.map((root) => {
      const group = props.functionGroups?.find((it) => it.name === root.name);
      return this.createWebFunction(
        root.name === DEFAULT_FUNCTION_GROUP
          ? "WebFunction"
          : `WebFunction-${root.name}`,
        root,
        group?.overrides,
      );
    });

    const defaultGroup = this.functionGroups.find(
      (group) => group.name === DEFAULT_FUNCTION_GROUP,
    );
    if (!defaultGroup) {
      throw new Error(
        `Expected a "${DEFAULT_FUNCTION_GROUP}" deployment root, got ` +
          `[${roots.map((root) => root.name).join(", ")}].`,
      );
    }
    this.webFunction = defaultGroup.webFunction;
    this.endpoint = defaultGroup.endpoint;
  }

  private createWebFunction(
    id: string,
    root: NextjsDeploymentRoot,
    groupOverrides: NextjsWebFunctionsOverrides | undefined,
  ): NextjsWebFunctionGroupResources {
    const shared = this.sharedWebFunctionProps(root.name);
    const own = groupOverrides?.webFunctionProps;
    const defaultEndpoint = {
      ...shared?.defaultEndpoint,
      ...own?.defaultEndpoint,
    };
    assertSupported(root.name, {
      defaultEndpointAuth:
        own?.defaultEndpointAuth ?? shared?.defaultEndpointAuth,
      endpointType: defaultEndpoint.endpointLocation?.endpointType,
    });
    // Zipped here rather than by `cdk-assets`, which would dereference the
    // pnpm symlinks the root depends on; see `zipDirectory`.
    const zipPath = `${root.path}.zip`;
    writeFileSync(zipPath, zipDirectory(root.path));
    const role =
      own?.role ??
      shared?.role ??
      // What the L2 would create, made here so it is an `IRole` that a
      // separate `Policy` can be attached to; see
      // `NextjsGlobalWebFunctions.wireCloudFrontInvalidation`.
      new Role(this, `${id}ServiceRole`, {
        assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
        managedPolicies: [
          ManagedPolicy.fromAwsManagedPolicyName(
            "service-role/AWSLambdaBasicExecutionRole",
          ),
        ],
      });
    const endpointName = defaultEndpoint.endpointName ?? DEFAULT_ENDPOINT_NAME;
    const webFunctionProps: WebFunctionProps = {
      code: WebFunctionCode.fromAssetToManagedBucket(zipPath),
      entryPoint: ENTRY_POINT,
      // Pinned, so a CDK upgrade can't move the app to another Node.js.
      runtime: WebFunctionRuntime.NODEJS_24_X,
      timeout: Duration.seconds(30),
      ...shared,
      ...own,
      role,
      // Checked by `assertSupported` above; restated so no spread can drop it.
      defaultEndpointAuth: WebFunctionAuthType.IAM_AUTH,
      defaultEndpoint: {
        ...defaultEndpoint,
        endpointLocation: WebFunctionEndpointLocation.homeRegion(),
        endpointName,
      },
      environment: {
        // What `next start` and the Containers Dockerfiles set. Externalized
        // packages (React for Pages Router SSR among them) load their dev
        // builds without it.
        NODE_ENV: "production",
        ...runtimeEnvironment(this.props),
        // Which group this function is, for a misrouted request's 500.
        [FUNCTION_GROUP_ENV_VAR]: root.name,
        // The endpoint CloudFront signs for, whose `x-forwarded-host` the
        // runtime trusts; see `isTrustedEndpoint`.
        [TRUSTED_ENDPOINT_ENV_VAR]: endpointName,
        ...shared?.environment,
        ...own?.environment,
      },
    };

    const webFunction = new WebFunction(this, id, webFunctionProps);
    grantRuntimeAccess(this.props, webFunction);

    return {
      name: root.name,
      routes: root.routes,
      webFunction,
      endpoint: webFunction.endpoint,
      role,
    };
  }

  /**
   * The construct-wide `webFunctionProps`, minus what identifies a single
   * function when this is not the `default` group; see
   * {@link NextjsWebFunctionsOverrides.webFunctionProps}.
   */
  private sharedWebFunctionProps(
    groupName: string,
  ): OptionalWebFunctionProps | undefined {
    const shared = this.props.overrides?.webFunctionProps;
    if (!shared || groupName === DEFAULT_FUNCTION_GROUP) {
      return shared;
    }
    const { webFunctionName, code, entryPoint, ...rest } = shared;
    return rest;
  }
}

/**
 * Fails on the two settings CloudFront can't reach the function with: an
 * `APPLICATION_MANAGED` endpoint is public, and Origin Access Control signs
 * only for `IAM_AUTH`; a multi- or per-Region endpoint needs SigV4A signing
 * and Region-local cache resources this construct doesn't create.
 */
function assertSupported(
  group: string,
  requested: {
    defaultEndpointAuth?: WebFunctionAuthType;
    endpointType?: WebFunctionEndpointType;
  },
) {
  const { defaultEndpointAuth, endpointType } = requested;
  if (
    defaultEndpointAuth !== undefined &&
    defaultEndpointAuth !== WebFunctionAuthType.IAM_AUTH
  ) {
    throw new Error(
      `${LOG_PREFIX} webFunctionProps.defaultEndpointAuth for function group ` +
        `"${group}" is ${defaultEndpointAuth}, but NextjsGlobalWebFunctions ` +
        `only supports ${WebFunctionAuthType.IAM_AUTH}: CloudFront's Origin ` +
        `Access Control signs requests only for that, and any other auth type ` +
        `would make the endpoint public.`,
    );
  }
  if (
    endpointType !== undefined &&
    endpointType !== WebFunctionEndpointType.HOME_REGION
  ) {
    throw new Error(
      `${LOG_PREFIX} webFunctionProps.defaultEndpoint.endpointLocation for ` +
        `function group "${group}" is ${endpointType}, but ` +
        `NextjsGlobalWebFunctions only supports homeRegion(): CloudFront ` +
        `already serves viewers globally, and the cache bucket and ` +
        `revalidation table are in the stack's Region.`,
    );
  }
}
