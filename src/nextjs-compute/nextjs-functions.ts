import { writeFileSync } from "node:fs";
import { Duration } from "aws-cdk-lib";
import {
  Architecture,
  Code,
  Function as LambdaFunction,
  FunctionProps,
  FunctionUrl,
  FunctionUrlAuthType,
  InvokeMode,
  Runtime,
  RuntimeFamily,
} from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import {
  grantRuntimeAccess,
  NextjsComputeBaseProps,
  runtimeEnvironment,
} from "./nextjs-compute-base-props";
import {
  DEFAULT_FUNCTION_GROUP,
  FUNCTION_GROUP_ENV_VAR,
} from "../adapter/function-groups";
import { LOG_PREFIX, NextjsType } from "../constants";
import { OptionalFunctionProps } from "../generated-structs/OptionalFunctionProps";
import { OptionalFunctionUrlProps } from "../generated-structs/OptionalFunctionUrlProps";
import { NextjsDeploymentRoot } from "../nextjs-build/nextjs-build";
import { RUNTIME_DIR_NAME } from "../runtime/manifest";
import { getLambdaArchitecture } from "../utils/get-architecture";
import { zipDirectory } from "../utils/zip-directory";

export interface NextjsFunctionsOverrides {
  /**
   * Props for the Lambda function.
   *
   * Construct-wide (`NextjsFunctionsProps.overrides`), these apply to every
   * function group's Lambda — memory, timeout, VPC, role and the rest are
   * shared — except the props that identify one function: `functionName`,
   * `code` and `handler` apply to the `default` group only. A second function
   * with the same name fails the deploy, and another group's code or handler
   * would ship the wrong deployment root. Set those per group, in the group's
   * own `overrides`, where they apply to that group alone.
   */
  readonly functionProps?: OptionalFunctionProps;
  readonly functionUrlProps?: OptionalFunctionUrlProps;
}

/**
 * A set of routes to package into their own Lambda function.
 *
 * The only reason to reach for this is Lambda's 250 MB unzipped limit. Every
 * group ships the *same* Next.js runtime and the same shared code — splitting
 * only moves route-local code (and whatever it pulls in) out of the other
 * functions. So group by what is heavy, not by what is logically related.
 *
 * Each group becomes one Lambda function and one CloudFront behavior per
 * pattern, out of a per-distribution budget of 75 that `public/` entries also
 * draw on. Routes not matched by any group stay in the implicit `default` group.
 *
 * Patterns are an exact path or a subtree, and nothing else:
 *
 * - `/pricing` — that route, exactly.
 * - `/api/reports/**` — everything *under* `/api/reports`, including
 *   `/api/reports/[id]`, but not `/api/reports` itself. List both to own both.
 *
 * Dynamic segments (`/blog/[slug]`) and route groups (`/(marketing)/about`) are
 * synth errors: CloudFront path patterns support only `*` and `?`, so neither
 * could be honored at the granularity it implies. Use a subtree.
 *
 * When two patterns match a route, the longest wins — `/api/**` in one group and
 * `/api/reports/**` in another is a valid and useful pair.
 *
 * @example
 * functionGroups: [
 *   { name: "reports", routes: ["/api/reports/**"] },
 *   { name: "admin", routes: ["/admin/**"], overrides: { functionProps: { memorySize: 3008 } } },
 * ]
 */
export interface NextjsFunctionGroup {
  /**
   * Group name. Becomes a construct id and part of the Lambda function name, so
   * it must match `/^[a-zA-Z0-9-]+$/`. `default` is reserved.
   */
  readonly name: string;
  /** Path patterns this group owns. At least one; see {@link NextjsFunctionGroup}. */
  readonly routes: string[];
  /**
   * Per-group overrides, merged over the construct-wide `overrides` — which is
   * the point of splitting for anything other than size: a group can have its
   * own memory, timeout, or concurrency. Not its own architecture: every group
   * deploys the one the build staged `sharp` for.
   */
  readonly overrides?: NextjsFunctionsOverrides;
}

/** One deployed function group: its Lambda, its URL, and what it serves. */
export interface NextjsFunctionGroupResources {
  /** Group name; `default` for the implicit catch-all group. */
  readonly name: string;
  /**
   * Route templates packaged into this function, as the adapter assigned them.
   * Empty for the default group is normal in a heavily split app.
   */
  readonly routes: string[];
  readonly function: LambdaFunction;
  /** Only for `GLOBAL_FUNCTIONS`; Regional fronts its functions with API Gateway. */
  readonly functionUrl?: FunctionUrl;
}

export interface NextjsFunctionsProps extends NextjsComputeBaseProps {
  readonly overrides?: NextjsFunctionsOverrides;
  /**
   * The staged deployment roots, one per function group, `default` among them.
   * @see NextjsBuild.deploymentRoots
   */
  readonly deploymentRoots: NextjsDeploymentRoot[];
  /**
   * The architecture `NextjsBuild` staged the deployment roots' native
   * dependencies (`sharp`) for, which every function deploys.
   * @see NextjsBuild.architecture
   * @default - the architecture of the machine running synth, as `NextjsBuild`'s
   */
  readonly architecture?: Architecture;
  /**
   * Per-group configuration, keyed by name against {@link deploymentRoots}.
   * Routes come from the build rather than from here, since the adapter resolved
   * them; this only carries `overrides`.
   */
  readonly functionGroups?: NextjsFunctionGroup[];
}

/**
 * Run Next.js in functions on AWS with AWS Lambda.
 *
 * A plain zip function on the Node.js managed runtime: the deployment root
 * `NextjsBuild` staged is the asset, and cdk-nextjs's own bundled shell
 * (`cdk-nextjs-runtime/lambda.mjs`) is the handler. It invokes the entrypoints
 * `next build` produced in-process, so there is no Next.js HTTP server, no
 * Docker image, and no Lambda Web Adapter — response streaming comes from
 * `awslambda.streamifyResponse` directly.
 */
export class NextjsFunctions extends Construct {
  /**
   * The `default` group's function: the one the distribution's default behavior
   * targets, and the only one at all unless `functionGroups` is used.
   *
   * A zip-packaged `lambda.Function` since 0.7.0; before that it was a
   * `DockerImageFunction`. Code that relied on the image-specific type (its
   * repository, or `DockerImageCode`) has to change.
   */
  function: LambdaFunction;
  /** The `default` group's Function URL. Only for `GLOBAL_FUNCTIONS`. */
  functionUrl?: FunctionUrl;
  /**
   * Every deployed group, `default` first. Iterate this rather than
   * {@link function} for anything that must reach all of them — IAM grants and
   * CloudFront behaviors both do.
   */
  functionGroups: NextjsFunctionGroupResources[];

  private props: NextjsFunctionsProps;

  constructor(scope: Construct, id: string, props: NextjsFunctionsProps) {
    super(scope, id);
    this.props = props;

    const roots = props.deploymentRoots;
    this.functionGroups = roots.map((root) => {
      const group = props.functionGroups?.find((it) => it.name === root.name);
      // The default group keeps the unsuffixed construct id it has always had,
      // so adding `functionGroups` to a deployed app does not replace the
      // function that was already serving everything.
      const fn = this.createFunction(
        root.name === DEFAULT_FUNCTION_GROUP
          ? "Functions"
          : `Functions-${root.name}`,
        root,
        group?.overrides,
      );
      let functionUrl: FunctionUrl | undefined;
      if (props.nextjsType === NextjsType.GLOBAL_FUNCTIONS) {
        functionUrl = fn.addFunctionUrl({
          authType: FunctionUrlAuthType.AWS_IAM,
          invokeMode: InvokeMode.RESPONSE_STREAM,
          ...props.overrides?.functionUrlProps,
          ...group?.overrides?.functionUrlProps,
        });
      }
      return {
        name: root.name,
        routes: root.routes,
        function: fn,
        functionUrl,
      };
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
    this.function = defaultGroup.function;
    this.functionUrl = defaultGroup.functionUrl;
  }

  private createFunction(
    id: string,
    root: NextjsDeploymentRoot,
    groupOverrides: NextjsFunctionsOverrides | undefined,
  ) {
    const architecture = this.props.architecture ?? getLambdaArchitecture();
    const requested =
      groupOverrides?.functionProps?.architecture ??
      this.props.overrides?.functionProps?.architecture;
    if (requested && requested.name !== architecture.name) {
      // Ignoring it would deploy a function the user didn't ask for; honoring
      // it would deploy one that can't load the `sharp` binaries staged for
      // the root. The root constructs pass the same value to both unless
      // `nextjsBuildProps.architecture` overrides `NextjsBuild`'s, a group's
      // own override asks for another (one architecture per deployment), or
      // `NextjsBuild` and `NextjsFunctions` are wired by hand.
      throw new Error(
        `${LOG_PREFIX} functionProps.architecture for function group "${root.name}" is ${requested.name}, ` +
          `but NextjsBuild staged its native dependencies (sharp) for ${architecture.name}. ` +
          "Every function group deploys one architecture: set it construct-wide in " +
          "`overrides.nextjsFunctions.functionProps`, drop a conflicting `nextjsBuildProps.architecture` " +
          "override, or, wiring the constructs yourself, pass NextjsBuild's `architecture` to NextjsFunctions.",
      );
    }
    // Zipped here rather than by `cdk-assets`, which would dereference the
    // pnpm symlinks the root depends on; see `zipDirectory`.
    const zipPath = `${root.path}.zip`;
    writeFileSync(zipPath, zipDirectory(root.path));
    const functionProps: FunctionProps = {
      code: Code.fromAsset(zipPath),
      handler: `${RUNTIME_DIR_NAME}/lambda.handler`,
      memorySize: 2048,
      runtime: new Runtime("nodejs24.x", RuntimeFamily.NODEJS),
      timeout: Duration.seconds(30),
      ...this.sharedFunctionProps(root.name),
      ...groupOverrides?.functionProps,
      // After the overrides: the function must run what `NextjsBuild` staged.
      // An override that disagrees throws above rather than being dropped here.
      architecture,
      environment: {
        // What `next start` and the Containers Dockerfiles set. Externalized
        // packages (React for Pages Router SSR among them) load their dev
        // builds without it.
        NODE_ENV: "production",
        ...runtimeEnvironment(this.props),
        // Which group this function is. Only used to make a misroute legible:
        // if CloudFront sends a request here for a route that was packaged
        // elsewhere, the 500 says which function got it and which group it
        // belongs to, rather than surfacing as a module-not-found deep inside
        // the Next.js server.
        [FUNCTION_GROUP_ENV_VAR]: root.name,
        ...this.props.overrides?.functionProps?.environment,
        ...groupOverrides?.functionProps?.environment,
      },
    };

    const fn = new LambdaFunction(this, id, functionProps);

    grantRuntimeAccess(this.props, fn);

    return fn;
  }

  /**
   * The construct-wide `functionProps`, minus what identifies a single function
   * when this is not the `default` group; see
   * {@link NextjsFunctionsOverrides.functionProps}.
   */
  private sharedFunctionProps(
    groupName: string,
  ): OptionalFunctionProps | undefined {
    const shared = this.props.overrides?.functionProps;
    if (!shared || groupName === DEFAULT_FUNCTION_GROUP) {
      return shared;
    }
    const { functionName, code, handler, ...rest } = shared;
    return rest;
  }
}
