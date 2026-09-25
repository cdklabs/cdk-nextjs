import { Annotations, Size, Stack } from "aws-cdk-lib";
import {
  RestApi,
  LambdaIntegration,
  AwsIntegration,
  MethodOptions,
  IResource,
  EndpointType,
  RestApiProps,
  AwsIntegrationProps,
  LambdaIntegrationOptions,
  PassthroughBehavior,
  ResponseTransferMode,
} from "aws-cdk-lib/aws-apigateway";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import {
  Role,
  ServicePrincipal,
  PolicyStatement,
  IRole,
} from "aws-cdk-lib/aws-iam";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { LOG_PREFIX } from "./constants";
import { PublicDirEntry } from "./nextjs-build/nextjs-build";
import { joinPath, normalizeBasePath } from "./utils/base-path";

/**
 * What API Gateway accepts as a resource path part, per CDK's own check in
 * `Resource`: `[a-zA-Z0-9:._-$]`, plus an optional trailing `+`.
 */
const API_PATH_PART = /^[a-zA-Z0-9:._\-$]+$/;

export interface NextjsApiOverrides {
  readonly restApiProps?: RestApiProps;
  readonly staticIntegrationProps?: AwsIntegrationProps;
  readonly s3MethodOptions?: MethodOptions;
  readonly dynamicIntegrationProps?: LambdaIntegrationOptions;
}

export interface NextjsApiProps {
  /**
   * Optional base path for the application
   */
  readonly basePath?: string;
  /**
   * Override props for every construct.
   */
  readonly overrides?: NextjsApiOverrides;
  /**
   * Path to directory of Next.js app's public directory. Used to add resources
   * to API Gateway REST API for public directory to go directly to S3.
   */
  readonly publicDirEntries: PublicDirEntry[];
  /**
   * Required if `NextjsRegionalFunctions`. The Lambda function for server-side rendering
   */
  readonly serverFunction?: IFunction;
  /**
   * The S3 bucket containing static assets
   */
  readonly staticAssetsBucket: IBucket;
  /**
   * S3 key prefix the static assets were uploaded under, i.e.
   * `NextjsStaticAssets.keyPrefix`, which namespaces a shared bucket.
   *
   * Independent of `basePath` above: that one is the URL prefix the REST API
   * serves the app at (commonly the API Gateway stage), while this one is where
   * the objects live in the bucket. `_next/static` and public directory
   * requests are mapped to S3 keys directly, so they 404 unless this prefix is
   * applied.
   */
  readonly staticAssetsKeyPrefix?: string;
  /**
   * [Future] Required if `NextjsRegionalContainers`. VPC to create VPC Link and ECS Service Discovery
   */
  readonly vpc?: IVpc;
  /**
   * The non-`default` function groups, each needing its own resources so the
   * routes it was packaged with reach it rather than {@link serverFunction}.
   * @default - no splitting; `{proxy+}` serves every dynamic route
   */
  readonly functionGroups?: NextjsApiFunctionGroup[];
  /**
   * Whether the app has Pages Router routes, and therefore a
   * `/_next/data/<buildId>/…json` URL space that has to be routed alongside the
   * HTML one. Ignored without {@link functionGroups}.
   * @default false
   */
  readonly hasDataRoutes?: boolean;
  /**
   * The app's `next.config` `trailingSlash`. Only used to warn, because an API
   * Gateway resource path cannot express the canonical URL it produces.
   * Ignored without {@link functionGroups}.
   * @default false
   * @see NextjsApi.warnOnTrailingSlashGroups
   */
  readonly trailingSlash?: boolean;
}

/** A non-default function group and the Lambda its routes must reach. */
export interface NextjsApiFunctionGroup {
  readonly name: string;
  /** Path patterns the group owns, as written in `NextjsFunctionGroup.routes`. */
  readonly routes: string[];
  readonly function: IFunction;
}

/**
 * Creates an API Gateway REST API for Next.js applications
 */
export class NextjsApi extends Construct {
  /**
   * The API Gateway REST API
   */
  public readonly api: RestApi;

  /**
   * Public URL of the app, including every path segment the API nests it under.
   * Prefers a custom domain configured through `overrides.restApiProps.domainName`
   * over the execute-api endpoint.
   *
   * A domain attached after this construct is created (`api.addDomainName()`) is
   * still used for the host, but CDK keeps its base path mappings private, so a
   * mapping added that way won't show up here.
   */
  get url(): string {
    const customDomain = this.api.domainName;
    // A custom domain reaches the stage through a base path mapping, so the
    // stage name isn't in the path there; the mapping may be, when set.
    const [origin, prefix] = customDomain
      ? [
          `https://${customDomain.domainName}`,
          this.props.overrides?.restApiProps?.domainName?.basePath,
        ]
      : [
          `https://${this.api.restApiId}.execute-api.${Stack.of(this).region}.amazonaws.com`,
          this.api.deploymentStage.stageName,
        ];
    return joinPath(origin, prefix, this.props.basePath);
  }

  private readonly baseResource: IResource;
  private readonly nextResource: IResource;
  /**
   * Resources created only as parents of a group route. API Gateway answers a
   * request for a resource with no method itself — 403 "Missing Authentication
   * Token" — rather than falling back to the root `{proxy+}`, so each gets the
   * default function in {@link createDynamicIntegration}. Without that a
   * `/api/reports/**` group turned `/api/reports` and `/api` into 403s.
   */
  private readonly groupParentResources = new Set<IResource>();
  private readonly groupRouteResources = new Set<IResource>();
  private readonly props: NextjsApiProps;
  private staticIntegrationRole: IRole;

  constructor(scope: Construct, id: string, props: NextjsApiProps) {
    super(scope, id);
    this.props = props;

    this.validateProps(props);
    this.api = this.createRestApi();
    this.baseResource = this.createBaseResource(props.basePath);
    this.nextResource = this.baseResource.addResource("_next");
    this.staticIntegrationRole = this.createStaticIntegrationRole();
    this.createStaticIntegrations();
    if (props.serverFunction) {
      // Group resources before the catch-all, so `addResource` sees a clean tree
      // and a group can claim a path the catch-all would otherwise serve.
      this.createFunctionGroupIntegrations();
      // `_next/image` has no resource of its own: it falls through to the
      // `{proxy+}` catch-all, and the server function optimizes in-process.
      this.createDynamicIntegration(props.serverFunction);
    } else if (props.vpc) {
      // [Future] create integration with ECS via VPC Link and ECS Service Discovery
    }
  }

  private validateProps(props: NextjsApiProps) {
    if (!props.serverFunction && !props.vpc) {
      throw new Error("serverFunction or vpc must be set in NextjsApiProps");
    }
  }

  private createRestApi(): RestApi {
    return new RestApi(this, "RestApi", {
      binaryMediaTypes: ["*/*"],
      description: `cdk-nextjs REST API for ${Stack.of(this).stackName}`,
      endpointTypes: [EndpointType.REGIONAL],
      // Inert for the dynamic routes: API Gateway does not compress a response it
      // streams (`ResponseTransferMode.STREAM`), which every Lambda integration
      // here uses, so the runtime gzips those itself. Kept because it still
      // applies to the buffered S3 static integrations, and because a consumer
      // who overrides an integration to BUFFERED gets compression back.
      minCompressionSize: Size.bytes(0),
      ...this.props.overrides?.restApiProps,
    });
  }

  /**
   * Create base resource path if needed. Important if `basePath` is set.
   *
   * A nested `basePath` ("/team/app") has to become one resource per segment:
   * API Gateway path parts can't contain "/", so passing the whole thing to a
   * single `addResource` fails validation at synth. `resolveBasePath` accepts
   * nested values, so this is reachable.
   */
  private createBaseResource(basePath?: string): IResource {
    // Create base resource path if needed
    const normalized = normalizeBasePath(basePath);
    if (!normalized) {
      return this.api.root;
    }
    return normalized
      .split("/")
      .reduce<IResource>(
        (parent, segment) => parent.addResource(segment),
        this.api.root,
      );
  }

  private createStaticIntegrationRole() {
    // Create S3 integration role
    const staticIntegrationRole = new Role(this, "StaticIntegrationRole", {
      assumedBy: new ServicePrincipal("apigateway.amazonaws.com"),
    });

    staticIntegrationRole.addToPolicy(
      new PolicyStatement({
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [
          this.props.staticAssetsBucket.bucketArn,
          `${this.props.staticAssetsBucket.bucketArn}/*`,
        ],
      }),
    );
    return staticIntegrationRole;
  }

  private createStaticIntegrations() {
    this.nextResource
      .addResource("static")
      .addResource("{proxy+}")
      .addMethod(
        "GET",
        this.createS3Integration({ key: this.s3Key("_next/static/{key}") }),
        this.getStaticMethodOptions({ proxy: true }),
      );
    // add public directory files/directories that exist at top level but need to go to S3.
    const unroutable: string[] = [];
    for (const publicDirEntry of this.props.publicDirEntries) {
      // A space or a non-ASCII character is legal in `public/` and illegal in an
      // API Gateway resource path part, and `addResource` throws — which took the
      // whole synth down for an app that deploys fine on the Global types
      // (`next-image-legacy/unicode`, whose `public/` holds "hello world.jpg").
      // Warn and skip the one entry instead: that asset 404s, the app deploys.
      if (!API_PATH_PART.test(publicDirEntry.name)) {
        unroutable.push(`"${publicDirEntry.name}"`);
        continue;
      }
      if (publicDirEntry.isDirectory) {
        this.baseResource
          .addResource(publicDirEntry.name)
          .addResource("{proxy+}")
          .addMethod(
            "GET",
            this.createS3Integration({
              key: this.s3Key(`${publicDirEntry.name}/{key}`),
            }),
            this.getStaticMethodOptions({ proxy: true }),
          );
      } else {
        this.baseResource
          .addResource(publicDirEntry.name)
          .addMethod(
            "GET",
            this.createS3Integration({ key: this.s3Key(publicDirEntry.name) }),
            this.getStaticMethodOptions(),
          );
      }
    }
    if (unroutable.length > 0) {
      Annotations.of(this).addWarning(
        `${LOG_PREFIX} An API Gateway resource path part only allows ` +
          "[a-zA-Z0-9:._-$], so these top-level public/ entries cannot be served " +
          `and will 404: ${unroutable.join(", ")}. Rename them, move them into a ` +
          "public/ subdirectory whose own name is expressible, or use " +
          "NextjsGlobalFunctions or NextjsGlobalContainers, whose CloudFront " +
          "behaviors can match them.",
      );
    }
  }

  /**
   * Prefixes a request path with the key prefix the assets were uploaded under,
   * since the S3 integrations address objects by key rather than by URL.
   */
  private s3Key(key: string): string {
    return joinPath(this.props.staticAssetsKeyPrefix, key);
  }

  /**
   * Maps API request to S3 request.
   * @see https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-parameter-mapping-sources.html
   * @see https://docs.aws.amazon.com/apigateway/latest/developerguide/integrating-api-with-aws-services-s3.html#api-items-in-folder-as-s3-objects-in-bucket
   */
  private createS3Integration({ key }: { key: string }) {
    const s3Integration = new AwsIntegration({
      service: "s3",
      integrationHttpMethod: "GET",
      path: `${this.props.staticAssetsBucket.bucketName}/${key}`,
      options: {
        credentialsRole: this.staticIntegrationRole,
        passthroughBehavior: PassthroughBehavior.WHEN_NO_TEMPLATES, // recommended
        requestParameters: {
          // Without this S3 never sees the conditional request, so every
          // revalidation of an immutable `_next/static` chunk re-downloads it
          // with a 200 instead of getting a 304.
          "integration.request.header.If-None-Match":
            "method.request.header.If-None-Match",
          "integration.request.header.If-Modified-Since":
            "method.request.header.If-Modified-Since",
          ...(key.includes("{key}")
            ? {
                "integration.request.path.key": "method.request.path.proxy",
              }
            : {}),
        },
        integrationResponses: [
          {
            statusCode: "200",
            responseParameters: {
              "method.response.header.Content-Type":
                "integration.response.header.Content-Type",
              "method.response.header.Content-Length":
                "integration.response.header.Content-Length",
              "method.response.header.Cache-Control":
                "integration.response.header.Cache-Control",
              "method.response.header.ETag": "integration.response.header.ETag",
              "method.response.header.Last-Modified":
                "integration.response.header.Last-Modified",
            },
          },
          {
            // A 304 carries no body, and `ETag` is the header a client needs
            // back to keep revalidating.
            statusCode: "304",
            selectionPattern: "304",
            responseParameters: {
              "method.response.header.Cache-Control":
                "integration.response.header.Cache-Control",
              "method.response.header.ETag": "integration.response.header.ETag",
              "method.response.header.Last-Modified":
                "integration.response.header.Last-Modified",
            },
          },
          {
            statusCode: "404",
            selectionPattern: "404",
          },
        ],
      },
      ...this.props.overrides?.staticIntegrationProps,
    });
    return s3Integration;
  }

  private getStaticMethodOptions({ proxy } = { proxy: false }): MethodOptions {
    return {
      requestParameters: {
        // Declared optional (`false`): a plain GET carries neither, and
        // requiring them would 400 it.
        "method.request.header.If-None-Match": false,
        "method.request.header.If-Modified-Since": false,
        ...(proxy ? { "method.request.path.proxy": true } : {}),
      },
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            "method.response.header.Content-Type": true,
            "method.response.header.Content-Length": true,
            "method.response.header.Cache-Control": true,
            "method.response.header.ETag": true,
            "method.response.header.Last-Modified": true,
          },
        },
        {
          statusCode: "304",
          responseParameters: {
            "method.response.header.Cache-Control": true,
            "method.response.header.ETag": true,
            "method.response.header.Last-Modified": true,
          },
        },
        {
          statusCode: "404",
        },
      ],
      ...this.props.overrides?.s3MethodOptions,
    };
  }

  /**
   * One resource subtree per function group pattern.
   *
   * Unlike CloudFront this needs no ordering: API Gateway matches on a resource
   * *tree*, so `/api/reports/{proxy+}` beats `/api/{proxy+}` beats `/{proxy+}`
   * structurally, and "longest pattern wins" comes for free. What does need care
   * is not creating the same path twice — two groups under `/api` share the `api`
   * resource — so every segment goes through {@link resourceFor}.
   */
  private createFunctionGroupIntegrations() {
    const groups = this.props.functionGroups;
    if (!groups?.length) {
      return;
    }
    this.warnOnTrailingSlashGroups(groups);
    for (const group of groups) {
      const integration = new LambdaIntegration(group.function, {
        responseTransferMode: ResponseTransferMode.STREAM,
        ...this.props.overrides?.dynamicIntegrationProps,
      });
      for (const route of group.routes) {
        this.assertRoutable(route, group.name);
        for (const path of this.resourcePathsFor(route)) {
          const resource = this.resourceFor(path);
          resource.addMethod("ANY", integration);
          this.groupRouteResources.add(resource);
        }
      }
    }
  }

  /**
   * The group pattern validation accepts every character a CloudFront path
   * pattern can hold, and API Gateway's path parts hold fewer: `~`, `@`, `+`,
   * `&` and quotes pass it and then fail `addResource` with an error that names
   * neither the group nor the pattern. Say which, and what to do instead.
   */
  private assertRoutable(route: string, groupName: string) {
    const segments = (route.endsWith("/**") ? route.slice(0, -3) : route)
      .split("/")
      .filter(Boolean);
    const invalid = segments.find((segment) => !API_PATH_PART.test(segment));
    if (invalid === undefined) {
      return;
    }
    throw new Error(
      `${LOG_PREFIX} functionGroups pattern "${route}" (group "${groupName}") ` +
        `has a segment, "${invalid}", that an API Gateway resource path part ` +
        "cannot hold: only [a-zA-Z0-9:._-$] are allowed. Route that path from " +
        "a pattern higher up the tree (e.g. its parent directory with `/**`), " +
        "or use NextjsGlobalFunctions, whose CloudFront behaviors allow it.",
    );
  }

  /**
   * An exact group route in a `trailingSlash` app cannot be routed here, so say so
   * at synth rather than at the first request.
   *
   * `trailingSlash: true` makes `/pricing/` the canonical URL, and API Gateway
   * matches a request path literally: `/pricing/` does not reach the `/pricing`
   * resource, it reaches the root `{proxy+}` and so the default function. There is
   * no resource that would catch it either — a path part cannot be empty, and a
   * `{proxy+}` child would claim every route *under* `/pricing` as well, packaging
   * routes into a group the edge never sends there. `NextjsDistribution` adds a
   * `pricing/` behavior instead, which is why only this construct warns.
   *
   * Subtree patterns are unaffected: `/reports/**` becomes
   * `/reports/{proxy+}`, which matches the slash-suffixed URLs beneath it.
   */
  private warnOnTrailingSlashGroups(groups: NextjsApiFunctionGroup[]) {
    if (!this.props.trailingSlash) {
      return;
    }
    const exact = groups.flatMap((group) =>
      group.routes
        .filter((route) => !route.endsWith("/**"))
        .map((route) => `"${route}" (group "${group.name}")`),
    );
    if (exact.length === 0) {
      return;
    }
    Annotations.of(this).addWarning(
      `${LOG_PREFIX} Your app sets \`trailingSlash: true\`, so it links to ` +
        `"/pricing/" rather than "/pricing", and an API Gateway resource path ` +
        `cannot match a trailing slash. These \`functionGroups\` patterns will ` +
        `only take effect for the slash-less URL, with the canonical one falling ` +
        `through to the default function: ${exact.join(", ")}. Write them as ` +
        `subtree patterns (e.g. "/reports/**") where that suits the app, or use ` +
        `NextjsGlobalFunctions, whose CloudFront behaviors cover both spellings.`,
    );
  }

  /**
   * Resource paths, as segment arrays, for one group pattern.
   *
   * A subtree gets `{proxy+}` as its last segment and so owns everything *under*
   * the path but not the path itself, matching both the CloudFront translation and
   * `assignRoutesToGroups`. An exact path gets no proxy segment, which leaves its
   * children falling through to the root `{proxy+}` — also the CloudFront result.
   */
  private resourcePathsFor(route: string): string[][] {
    const isSubtree = route.endsWith("/**");
    const base = (isSubtree ? route.slice(0, -3) : route)
      .split("/")
      .filter(Boolean);
    const paths = [isSubtree ? [...base, "{proxy+}"] : base];
    if (this.props.hasDataRoutes) {
      // `<buildId>` changes every build, so it is a path parameter rather than a
      // literal — the integration ignores it, the runtime reads it off the URL.
      const dataPrefix = ["_next", "data", "{buildId}"];
      paths.push(
        isSubtree
          ? [...dataPrefix, ...base, "{proxy+}"]
          : [
              ...dataPrefix,
              ...base.slice(0, -1),
              `${base[base.length - 1]}.json`,
            ],
      );
    }
    return paths;
  }

  /** Walk or create a resource path, reusing whatever already exists. */
  private resourceFor(segments: string[]): IResource {
    let resource = this.baseResource;
    for (const [index, segment] of segments.entries()) {
      const existing = resource.getResource(segment);
      resource = existing ?? resource.addResource(segment);
      if (!existing && index < segments.length - 1) {
        this.groupParentResources.add(resource);
      }
    }
    return resource;
  }

  /**
   * Create Lambda Proxy integration for all other routes
   */
  private createDynamicIntegration(serverFunction: IFunction) {
    // All other routes use streaming for better performance
    const streamingIntegration = new LambdaIntegration(serverFunction, {
      responseTransferMode: ResponseTransferMode.STREAM,
      ...this.props.overrides?.dynamicIntegrationProps,
    });

    // Add catch-all routes with streaming integration for server-side rendering
    this.baseResource.addMethod("ANY", streamingIntegration);
    for (const resource of this.groupParentResources) {
      if (!this.groupRouteResources.has(resource)) {
        resource.addMethod("ANY", streamingIntegration);
      }
    }
    const proxyResource = this.baseResource.addResource("{proxy+}");
    proxyResource.addMethod("ANY", streamingIntegration);
  }
}
