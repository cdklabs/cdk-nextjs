import { Duration, Stack } from "aws-cdk-lib";
import { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AddBehaviorOptions,
  AllowedMethods,
  BehaviorOptions,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CachePolicyProps,
  CacheQueryStringBehavior,
  CachedMethods,
  Function as CloudFrontFunction,
  Distribution,
  FunctionAssociation,
  FunctionCode,
  FunctionEventType,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  IOrigin,
  IOriginRequestPolicy,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  ResponseHeadersPolicy,
  ResponseHeadersPolicyProps,
  ResponseSecurityHeadersBehavior,
  SecurityPolicyProtocol,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import {
  FunctionUrlOrigin,
  FunctionUrlOriginWithOACProps,
  S3BucketOrigin,
  VpcOrigin,
  VpcOriginWithEndpointProps,
} from "aws-cdk-lib/aws-cloudfront-origins";
import { IApplicationLoadBalancer } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { IFunctionUrl } from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { pathPatternsFor } from "./adapter/function-groups";
import { LOG_PREFIX, NextjsType } from "./constants";
import { OptionalDistributionProps } from "./generated-structs/OptionalDistributionProps";
import { OptionalS3OriginBucketWithOACProps } from "./generated-structs/OptionalS3OriginBucketWithOACProps";
import { PublicDirEntry } from "./nextjs-build/nextjs-build";
import { assetPrefixPath, normalizeBasePath } from "./utils/base-path";

export interface NextjsDistributionOverrides {
  readonly distributionProps?: OptionalDistributionProps;
  readonly imageBehaviorOptions?: AddBehaviorOptions;
  readonly imageCachePolicyProps?: CachePolicyProps;
  readonly imageResponseHeadersPolicyProps?: ResponseHeadersPolicyProps;
  readonly dynamicBehaviorOptions?: AddBehaviorOptions;
  readonly dynamicCachePolicyProps?: CachePolicyProps;
  readonly dynamicResponseHeadersPolicyProps?: ResponseHeadersPolicyProps;
  readonly dynamicFunctionUrlOriginWithOACProps?: FunctionUrlOriginWithOACProps;
  readonly dynamicVpcOriginWithEndpointProps?: VpcOriginWithEndpointProps;
  readonly staticBehaviorOptions?: AddBehaviorOptions;
  readonly staticResponseHeadersPolicyProps?: ResponseHeadersPolicyProps;
  readonly s3BucketOriginProps?: OptionalS3OriginBucketWithOACProps;
}

export interface NextjsDistributionProps {
  /**
   * Bucket containing static assets.
   * Must be provided if you want to serve static files.
   */
  readonly assetsBucket: IBucket;
  /**
   * The app's own `assetPrefix`. Next.js emits `<assetPrefix>/_next/static/...`
   * for every bundle while the objects stay at `<basePath>/_next/static/...` in
   * S3, so the prefix's path gets a cache behavior of its own that rewrites it
   * away.
   *
   * Either form is accepted: a path ("/cdn"), or an absolute URL, in which case
   * only its path counts ("https://cdn.example.com/cdn" behaves as "/cdn", and
   * "https://cdn.example.com" needs no behavior at all). An absolute prefix's path
   * matters because `next build` compiles a `/cdn/_next/:path+` rewrite of its
   * own, so `next start` serves every bundle under it — a CDN fronting this
   * distribution there has to be answered too.
   *
   * Applied on top of `basePath`, not under it, because that is how Next.js
   * builds the URL.
   *
   * @default - read from the build's `required-server-files.json`
   */
  readonly assetPrefix?: string;
  /**
   * URI path prefix the app is served at. Surrounding slashes are normalized
   * away, so "/base", "base" and "/base/" all produce the same cache behaviors.
   */
  readonly basePath?: string;
  /**
   * Optional but only applicable for `NextjsType.GLOBAL_CONTAINERS`
   */
  readonly certificate?: ICertificate;
  readonly distribution?: Distribution;
  /**
   * Required if `NextjsType.GLOBAL_FUNCTIONS`
   */
  readonly functionUrl?: IFunctionUrl;
  /**
   * Required if `NextjsType.GLOBAL_CONTAINERS` or `NextjsType.REGIONAL_CONTAINERS`
   */
  readonly loadBalancer?: IApplicationLoadBalancer;
  readonly nextjsType: NextjsType;
  /**
   * Override props for every construct.
   */
  readonly overrides?: NextjsDistributionOverrides;
  /**
   * Entries (files/directories) within Next.js app's public directory. Used to
   * add static behaviors to distribution.
   */
  readonly publicDirEntries: PublicDirEntry[];
  /**
   * The non-`default` function groups, each needing its own behaviors so the
   * routes it was packaged with reach it rather than the default function.
   * @default - no splitting; the default behavior serves every dynamic route
   */
  readonly functionGroups?: NextjsDistributionFunctionGroup[];
  /**
   * Whether the app has Pages Router routes, and therefore a
   * `/_next/data/<buildId>/…json` URL space that has to be routed alongside the
   * HTML one. Ignored without {@link functionGroups}.
   * @default false
   */
  readonly hasDataRoutes?: boolean;
  /**
   * The app's `next.config` `trailingSlash`. A `trailingSlash` app links to
   * `/pricing/`, which an exact group pattern of `pricing` does not match, so
   * each one needs a slash variant. Ignored without {@link functionGroups}.
   * @default false
   */
  readonly trailingSlash?: boolean;
}

/** A non-default function group and the origin its routes must reach. */
export interface NextjsDistributionFunctionGroup {
  readonly name: string;
  /** Path patterns the group owns, as written in `NextjsFunctionGroup.routes`. */
  readonly routes: string[];
  /** The group's Lambda Function URL. */
  readonly functionUrl: IFunctionUrl;
}

export class NextjsDistribution extends Construct {
  distribution: Distribution;

  private props: NextjsDistributionProps;
  /**
   * `props.basePath` normalized to a bare path segment. This construct is the
   * one place that needs it with a leading slash — CloudFront path patterns are
   * written against the request path — so it prepends its own rather than
   * relying on the caller having passed one.
   */
  private basePath: string;
  /**
   * `props.assetPrefix` normalized to a leading-slash path, `""` when the app
   * sets none or sets one that already equals the `basePath` prefix — in which
   * case the ordinary `_next/static*` behavior already covers it and a second one
   * would be a duplicate pattern CloudFront rejects.
   */
  private assetPrefix: string;
  /**
   * Common security headers applied by default to all origins
   * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-response-headers-policies.html#managed-response-headers-policies-security
   */
  private commonSecurityHeadersBehavior: ResponseSecurityHeadersBehavior = {
    contentTypeOptions: { override: false },
    frameOptions: {
      frameOption: HeadersFrameOption.SAMEORIGIN,
      override: false,
    },
    referrerPolicy: {
      override: false,
      referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
    },

    strictTransportSecurity: {
      accessControlMaxAge: Duration.days(365),
      includeSubdomains: true,
      override: false,
      preload: true,
    },
    xssProtection: { override: false, protection: true, modeBlock: true },
  };
  private staticOrigin: IOrigin;
  private dynamicOrigin: IOrigin;
  private dynamicOriginResponsePolicy: IOriginRequestPolicy;
  private dynamicCloudFrontFunctionAssociations: FunctionAssociation[];
  private isFunctionCompute: boolean;
  private staticBehaviorOptions: BehaviorOptions;
  private dynamicBehaviorOptions: BehaviorOptions;
  private imageBehaviorOptions: BehaviorOptions;

  constructor(scope: Construct, id: string, props: NextjsDistributionProps) {
    super(scope, id);
    this.props = props;
    this.basePath = normalizeBasePath(props.basePath);
    this.assetPrefix = this.resolveAssetPrefix();
    this.staticOrigin = this.createStaticOrigin();
    this.isFunctionCompute = props.nextjsType === NextjsType.GLOBAL_FUNCTIONS;
    this.dynamicOrigin = this.createDynamicOrigin();
    this.dynamicOriginResponsePolicy = this.createDynamicOriginRequestPolicy();
    this.dynamicCloudFrontFunctionAssociations =
      this.createDynamicCloudFrontFunctionAssociations();
    this.staticBehaviorOptions = this.createStaticBehaviorOptions();
    this.dynamicBehaviorOptions = this.createDynamicBehaviorOptions();
    this.imageBehaviorOptions = this.createImageBehaviorOptions();
    this.distribution = this.getDistribution();
    this.addStaticBehaviors();
    this.addDynamicBehaviors();
  }

  /**
   * Creates a CloudFront comment that is safe for the 128 character limit.
   * If the full comment with stack name exceeds 128 characters, returns the base comment only.
   * @param baseComment The base comment text
   * @param stackName The stack name to append
   * @returns A comment string that is guaranteed to be < 128 characters
   */
  private getComment(baseComment: string, stackName: string): string {
    const fullComment = `${baseComment} for ${stackName}`;
    return fullComment.length < 128 ? fullComment : baseComment;
  }

  private createStaticOrigin(): IOrigin {
    return S3BucketOrigin.withOriginAccessControl(
      this.props.assetsBucket,
      this.props.overrides?.s3BucketOriginProps,
    );
  }
  private createDynamicOrigin(): IOrigin {
    if (this.isFunctionCompute) {
      if (!this.props.functionUrl) {
        throw new Error("Missing NextjsDistributionProps.functionUrl");
      }
      return FunctionUrlOrigin.withOriginAccessControl(
        this.props.functionUrl,
        this.props.overrides?.dynamicFunctionUrlOriginWithOACProps,
      );
    } else {
      const loadBalancer = this.props.loadBalancer;
      if (!loadBalancer) {
        throw new Error("Missing NextjsDistributionProps.loadBalancer");
      }
      return VpcOrigin.withApplicationLoadBalancer(loadBalancer, {
        protocolPolicy: this.props.certificate
          ? OriginProtocolPolicy.HTTPS_ONLY
          : OriginProtocolPolicy.HTTP_ONLY,
        ...this.props.overrides?.dynamicVpcOriginWithEndpointProps,
      });
    }
  }
  /**
   * Lambda Function URLs "expect the `Host` header to contain the origin domain
   * name, not the domain name of the CloudFront distribution."
   * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html#managed-origin-request-policy-all-viewer-except-host-header
   */
  private createDynamicOriginRequestPolicy(): IOriginRequestPolicy {
    return this.isFunctionCompute
      ? OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER
      : OriginRequestPolicy.ALL_VIEWER;
  }
  /**
   * Ensures Next.js `request.url` will be correct domain instead of URL of
   * compute (Lambda or Fargate)
   * @see https://open-next.js.org/advanced/workaround#workaround-set-x-forwarded-host-header-aws-specific
   */
  private createDynamicCloudFrontFunctionAssociations(): FunctionAssociation[] {
    const associations: FunctionAssociation[] = [];
    if (this.isFunctionCompute) {
      const cloudFrontFn = new CloudFrontFunction(this, "CloudFrontFn", {
        // cloudfront-js-1.0, so ES5.1: `var`, no arrow functions, no template
        // literals, no `Object.keys`.
        code: FunctionCode.fromInline(`
          function handler(event) {
            var request = event.request;
            var uri = request.uri;

            // Next.js answers any path containing a backslash or a repeated
            // slash with a 308 to the collapsed path
            // (\`normalizeRepeatedSlashes\`, called from \`base-server.ts\`), and so
            // does this runtime. Behind a Lambda Function URL the origin never
            // gets the chance: Origin Access Control signs the raw path while the
            // Function URL canonicalizes it before verifying, so the origin
            // answers 403 SignatureDoesNotMatch. Doing the redirect here is what
            // makes \`/basepath//to-sv\` behave as it does under \`next start\`.
            //
            // A bare \`//\` reaches here too, and is answered the same way -
            // measured, because \`//\` at the start of a request target is also the
            // authority form and it was not obvious CloudFront would route it to a
            // function at all. It does: \`GET //\` answers 308 to \`/\` with
            // \`x-cache: FunctionGeneratedResponse\`, over both HTTP/1.1 and HTTP/2,
            // which is what \`test/e2e/hydration\` asks for.
            //
            // Two things Next.js does that this cannot:
            //
            // - the body it sends with its own redirect (the destination, as
            //   text), because a generated response can only carry one on
            //   cloudfront-js-2.0. No known client reads it.
            // - the original order of the query string. The event exposes
            //   \`querystring\` as an object, never as the raw string, so
            //   \`/x//y?a=1&b=2\` redirects to \`/x/y?b=2&a=1\`. The pairs all
            //   survive; only their order is CloudFront's rather than the
            //   client's, and a redirect target is not order-sensitive.
            if (/\\\\|\\/\\//.test(uri)) {
              var location = uri.replace(/\\\\/g, "/").replace(/\\/\\/+/g, "/");
              var qs = [];
              for (var name in request.querystring) {
                var q = request.querystring[name];
                qs.push(q.value === "" ? name : name + "=" + q.value);
                if (q.multiValue) {
                  for (var i = 0; i < q.multiValue.length; i++) {
                    var v = q.multiValue[i].value;
                    qs.push(v === "" ? name : name + "=" + v);
                  }
                }
              }
              if (qs.length) {
                location = location + "?" + qs.join("&");
              }
              return {
                statusCode: 308,
                statusDescription: "Permanent Redirect",
                headers: { location: { value: location } },
              };
            }

            request.headers["x-forwarded-host"] = request.headers.host;
            return request;
          }
          `),
      });
      associations.push({
        eventType: FunctionEventType.VIEWER_REQUEST,
        function: cloudFrontFn,
      });
    }
    return associations;
  }
  private createStaticBehaviorOptions(): BehaviorOptions {
    const staticBehaviorOptions = this.props.overrides?.staticBehaviorOptions;
    const responseHeadersPolicy =
      staticBehaviorOptions?.responseHeadersPolicy ??
      new ResponseHeadersPolicy(this, "StaticResponseHeadersPolicy", {
        securityHeadersBehavior: this.commonSecurityHeadersBehavior,
        comment: this.getComment(
          "NextJS Static Response Headers Policy",
          Stack.of(this).stackName,
        ),
        ...this.props.overrides?.staticResponseHeadersPolicyProps,
      });
    return {
      allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
      cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      origin: this.staticOrigin,
      responseHeadersPolicy,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      ...staticBehaviorOptions,
    };
  }
  private createDynamicBehaviorOptions(): BehaviorOptions {
    const dynamicBehaviorOptions = this.props.overrides?.dynamicBehaviorOptions;
    // create default cache policy if not provided
    const cachePolicy =
      dynamicBehaviorOptions?.cachePolicy ??
      new CachePolicy(this, "DynamicCachePolicy", {
        queryStringBehavior: CacheQueryStringBehavior.all(),
        headerBehavior: CacheHeaderBehavior.allowList(
          // NOTE: CloudFront Custom Cache Policies have soft max of 10 headers
          // cdk-nextjs includes the most essential headers for Next.js functionality
          // but it's recommended to request quota increase to include all headers (commented out ones below)
          // more here: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-policies
          "accept", // content negotiation (HTML vs RSC payload)
          "rsc", // React Server Components requests
          "next-url", // Next.js routing
          "next-router-state-tree", // App Router navigation state
          "next-router-prefetch", // prefetch behavior
          "next-router-segment-prefetch", // segment-level prefetching
          "x-matched-path", // dynamic routes and rewrites
          "x-prerender-revalidate", // on-demand ISR revalidation
          "x-next-cache-tags", // tag-based cache revalidation
          "x-prerender-bypass", // draft mode
          // "x-nextjs-stale-time", // stale-while-revalidate behavior
          // "x-next-cache-tag-token", // auth token for cache tags (only needed with revalidateTag auth)
          // "x-nextjs-postponed", // Partial Prerendering (experimental feature)
          // "x-prerender-revalidate-if-generated", // conditional revalidation (niche use case)
        ),
        cookieBehavior: CacheCookieBehavior.all(),
        // A response with no `Cache-Control` is not cached, which is what Next.js
        // and every app written for it assume: a dynamic route handler sets none.
        // CDK's default is a day, which cached `/api/*` responses at the edge for
        // 24 hours. Anything Next.js *means* to cache - ISR, SSG, a PPR shell -
        // says so with `s-maxage`, which `maxTtl` still honors.
        defaultTtl: Duration.seconds(0),
        enableAcceptEncodingBrotli: true,
        enableAcceptEncodingGzip: true,
        comment: this.getComment(
          "NextJS Dynamic Cache Policy",
          Stack.of(this).stackName,
        ),
        ...this.props.overrides?.dynamicCachePolicyProps,
      });
    const responseHeadersPolicy =
      dynamicBehaviorOptions?.responseHeadersPolicy ??
      new ResponseHeadersPolicy(this, "DynamicResponseHeadersPolicy", {
        securityHeadersBehavior: this.commonSecurityHeadersBehavior,
        comment: this.getComment(
          "NextJS Dynamic Response Headers Policy",
          Stack.of(this).stackName,
        ),
        ...this.props.overrides?.dynamicResponseHeadersPolicyProps,
      });
    return {
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy,
      functionAssociations: this.dynamicCloudFrontFunctionAssociations,
      origin: this.dynamicOrigin,
      originRequestPolicy: this.dynamicOriginResponsePolicy,
      responseHeadersPolicy,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      ...dynamicBehaviorOptions,
    };
  }
  /**
   * `_next/image*` goes to the same origin as everything else — the Next.js
   * server optimizes images in-process — but keeps its own behavior for the
   * cache policy: `queryStringBehavior: all()` plus `accept` in the cache key is
   * right for image requests and wrong for the rest.
   */
  private createImageBehaviorOptions(): BehaviorOptions {
    const imageBehaviorOptions = this.props.overrides?.imageBehaviorOptions;
    // add default cache policy if not provided
    const cachePolicy =
      imageBehaviorOptions?.cachePolicy ??
      new CachePolicy(this, "ImageCachePolicy", {
        // SECURITY NOTE: by default we don't include cookies in cache for
        // images b/c it significantly improves image perf for most sites BUT
        // if you have private images locked behind auth implemented with cookies
        // you need to override this.
        queryStringBehavior: CacheQueryStringBehavior.all(),
        headerBehavior: CacheHeaderBehavior.allowList("accept"),
        cookieBehavior: CacheCookieBehavior.none(),
        enableAcceptEncodingBrotli: true,
        enableAcceptEncodingGzip: true,
        comment: this.getComment(
          "NextJS Image Cache Policy",
          Stack.of(this).stackName,
        ),
        ...this.props.overrides?.imageCachePolicyProps,
      });
    // add default response headers policy if not provided
    const responseHeadersPolicy =
      imageBehaviorOptions?.responseHeadersPolicy ??
      new ResponseHeadersPolicy(this, "ImageResponseHeadersPolicy", {
        securityHeadersBehavior: this.commonSecurityHeadersBehavior,
        comment: this.getComment(
          "NextJS Image Response Headers Policy",
          Stack.of(this).stackName,
        ),
        ...this.props.overrides?.imageResponseHeadersPolicyProps,
      });
    return {
      allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
      functionAssociations: this.dynamicCloudFrontFunctionAssociations,
      origin: this.dynamicOrigin,
      originRequestPolicy: this.dynamicOriginResponsePolicy,
      cachePolicy,
      responseHeadersPolicy,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      ...imageBehaviorOptions,
    };
  }
  /**
   * Creates or uses user specified CloudFront Distribution
   */
  private getDistribution(): Distribution {
    let distribution: Distribution;
    if (this.props.distribution) {
      distribution = this.props.distribution;
    } else {
      distribution = new Distribution(this, "Distribution", {
        minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
        defaultBehavior: this.dynamicBehaviorOptions,
        // best to use HTTP 2 and 3 for compatability (HTTP 2) and performance (HTTP3)
        // CloudFront will choose best option for client
        httpVersion: HttpVersion.HTTP2_AND_3,
        comment: this.getComment(
          "NextJS Distribution",
          Stack.of(this).stackName,
        ),
        ...this.props.overrides?.distributionProps,
      });
    }
    return distribution;
  }
  private addDynamicBehaviors() {
    // Image Behavior
    this.distribution.addBehavior(
      this.getPathPattern("_next/image*"),
      this.imageBehaviorOptions.origin,
      this.imageBehaviorOptions,
    );
    // Function group behaviors, before the basePath catch-all below and after
    // `_next/image*` (no group pattern can match an image request, and keeping
    // the order of the unsplit case byte-identical is worth more than symmetry).
    this.addFunctionGroupBehaviors();
    // Root Path Behaviors
    if (this.basePath) {
      // because we already have a basePath we don't use / instead we use /base-path
      this.distribution.addBehavior(
        `/${this.basePath}`,
        this.dynamicBehaviorOptions.origin,
        this.dynamicBehaviorOptions,
      );
      // when basePath is set, we emulate the "default behavior" (*) for the site as `/base-path/*`
      this.distribution.addBehavior(
        this.getPathPattern("*"),
        this.dynamicBehaviorOptions.origin,
        this.dynamicBehaviorOptions,
      );
    } else {
      // if no base path, then default behavior will handle all other paths
    }
  }
  /** Shared by the behaviors themselves and by the budget that counts them. */
  private get pathPatternOptions() {
    return {
      hasDataRoutes: this.props.hasDataRoutes ?? false,
      trailingSlash: this.props.trailingSlash ?? false,
    };
  }
  /**
   * One behavior per group pattern, most specific first.
   *
   * The order is the whole mechanism. CloudFront evaluates behaviors in order
   * and stops at the first whose path pattern matches, and `addBehavior`
   * appends — so `api/*` added before `api/reports/*` would swallow every
   * report request and send it to a function whose package has no report
   * entrypoint. Sorting here is what makes "longest pattern wins" true at the
   * edge, matching how `assignRoutesToGroups` packaged the same routes.
   */
  private addFunctionGroupBehaviors() {
    const groups = this.props.functionGroups;
    if (!groups?.length) {
      return;
    }
    if (!this.isFunctionCompute) {
      throw new Error(
        "`functionGroups` is only supported by NextjsGlobalFunctions.",
      );
    }
    const behaviors = groups
      .flatMap((group) =>
        group.routes.flatMap((route) =>
          pathPatternsFor(route, this.pathPatternOptions).map((pattern) => ({
            group,
            route,
            pattern,
          })),
        ),
      )
      .sort(
        (a, b) =>
          behaviorSpecificity(b.pattern) - behaviorSpecificity(a.pattern),
      );

    const originPerGroup = new Map<string, IOrigin>();
    for (const { group, pattern } of behaviors) {
      let origin = originPerGroup.get(group.name);
      if (!origin) {
        origin = FunctionUrlOrigin.withOriginAccessControl(
          group.functionUrl,
          this.props.overrides?.dynamicFunctionUrlOriginWithOACProps,
        );
        originPerGroup.set(group.name, origin);
      }
      // Same behavior options as every other dynamic route — only the origin
      // differs, and it is passed separately.
      const { origin: _ignored, ...behaviorOptions } =
        this.dynamicBehaviorOptions;
      this.distribution.addBehavior(
        this.getPathPattern(pattern),
        origin,
        behaviorOptions,
      );
    }
  }
  /**
   * The `assetPrefix` path that needs a behavior of its own, or `""` for none.
   *
   * An absolute prefix contributes its *path*: "https://cdn.example.com" needs no
   * behavior, but "https://cdn.example.com/cdn" does, because `next build`
   * compiles a `/cdn/_next/:path+` rewrite of its own and `next start` serves
   * every bundle under that path — so a CDN fronting this distribution there has
   * to be answered. A prefix equal to the `basePath` prefix is dropped — that is
   * the Next.js default when `basePath` is set, and `_next/static*` already
   * resolves under it, so adding a second identical pattern would make CloudFront
   * reject the distribution.
   */
  private resolveAssetPrefix(): string {
    const prefix = assetPrefixPath(this.props.assetPrefix ?? "");
    return normalizeBasePath(prefix) === this.basePath ? "" : prefix;
  }
  /**
   * Serves `<assetPrefix>/_next/static/*` from the same S3 objects as
   * `_next/static/*`.
   *
   * Needed because Next.js puts `assetPrefix` in front of every bundle URL it
   * emits while the objects keep their `<basePath>/_next/static/...` keys, and
   * `assetPrefix` sits on top of `basePath` rather than under it, so
   * `getPathPattern` is deliberately not used here. Without this behavior the
   * request falls through to the default one, reaches the compute origin, and
   * 404s: the deployment package carries no `.next/static` directory at all.
   *
   * A viewer-request function does the rewrite because an S3 origin keys on the
   * request URI and `originPath` can only prepend. The prefix is a synth-time
   * literal, so the function is a fixed-length string operation rather than a
   * parse.
   */
  private addAssetPrefixBehavior() {
    // CloudFront allows one function per event type per behavior, so an override
    // that already claims VIEWER_REQUEST on the static behavior cannot coexist
    // with the rewrite below — the distribution would synth and then be rejected
    // at deploy, naming neither. Thrown here instead, where both halves are
    // known.
    const claimed = (
      this.staticBehaviorOptions.functionAssociations ?? []
    ).some(
      (association) =>
        association.eventType === FunctionEventType.VIEWER_REQUEST,
    );
    if (claimed) {
      throw new Error(
        `${LOG_PREFIX} \`overrides.staticBehaviorOptions.functionAssociations\` ` +
          `already associates a CloudFront function with ` +
          `${FunctionEventType.VIEWER_REQUEST}, but serving \`assetPrefix\` ` +
          `("${this.assetPrefix}") needs that event type to rewrite the request ` +
          `URI to the object's key, and CloudFront permits only one function per ` +
          `event type per behavior. Either drop the override, or fold its logic ` +
          `into a single function and set \`assetPrefix\` to "" so this ` +
          `construct adds no behavior of its own.`,
      );
    }
    const rewrite = new CloudFrontFunction(this, "AssetPrefixFn", {
      comment: this.getComment(
        "NextJS assetPrefix rewrite",
        Stack.of(this).stackName,
      ),
      code: FunctionCode.fromInline(`
        function handler(event) {
          var request = event.request;
          request.uri = ${JSON.stringify(
            this.basePath ? `/${this.basePath}` : "",
          )} + request.uri.slice(${this.assetPrefix.length});
          return request;
        }
        `),
    });
    this.distribution.addBehavior(
      `${this.assetPrefix}/_next/static*`,
      this.staticOrigin,
      {
        ...this.staticBehaviorOptions,
        functionAssociations: [
          ...(this.staticBehaviorOptions.functionAssociations ?? []),
          { eventType: FunctionEventType.VIEWER_REQUEST, function: rewrite },
        ],
      },
    );
  }
  private addStaticBehaviors() {
    this.distribution.addBehavior(
      this.getPathPattern("_next/static*"),
      this.staticOrigin,
      this.staticBehaviorOptions,
    );
    if (this.assetPrefix) {
      this.addAssetPrefixBehavior();
    }
    this.assertBehaviorBudget();
    for (const publicFile of this.props.publicDirEntries) {
      const pathPattern = publicFile.isDirectory
        ? `${toPathPattern(publicFile.name)}/*`
        : toPathPattern(publicFile.name);
      const finalPathPattern = this.getPathPattern(pathPattern);
      this.distribution.addBehavior(
        finalPathPattern,
        this.staticOrigin,
        this.staticBehaviorOptions,
      );
    }
  }
  /**
   * CloudFront allows 25 cache behaviors per distribution, counting the default
   * one, and there are now three things competing for them: `public/` entries,
   * function groups, and cdk-nextjs's own fixed set. Checked in one place so the
   * error can say which of the three to cut.
   *
   * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-web-distributions
   */
  private assertBehaviorBudget() {
    const groupPatterns = (this.props.functionGroups ?? []).reduce(
      (total, group) =>
        total +
        group.routes.reduce(
          (count, route) =>
            count + pathPatternsFor(route, this.pathPatternOptions).length,
          0,
        ),
      0,
    );
    // The default behavior, `_next/image*`, `_next/static*`, plus — with a
    // basePath — the two that stand in for the default behavior's coverage, and
    // — with a path-style assetPrefix — the one that serves bundles under it.
    // `this.basePath`, not the raw prop: `basePath: "/"` normalizes to `""` and
    // adds no behaviors, so counting it added 2 to the total and could throw
    // "over the limit" on an app that is under it.
    const fixed = 3 + (this.basePath ? 2 : 0) + (this.assetPrefix ? 1 : 0);
    const total = fixed + this.props.publicDirEntries.length + groupPatterns;
    if (total <= MAX_CACHE_BEHAVIORS) {
      return;
    }
    const parts = [
      `${fixed} used by cdk-nextjs itself`,
      `${this.props.publicDirEntries.length} for top-level public/ entries`,
    ];
    if (groupPatterns) {
      parts.push(`${groupPatterns} for \`functionGroups\` patterns`);
    }
    throw new Error(
      `This Next.js app needs ${total} CloudFront cache behaviors, over the ` +
        `limit of ${MAX_CACHE_BEHAVIORS} per distribution: ${parts.join(", ")}. ` +
        `Move public/ files into a single top-level directory (one behavior ` +
        `serves \`static/*\`)` +
        (groupPatterns
          ? `, and prefer one subtree pattern per function group over several ` +
            `exact paths.`
          : `.`) +
        ` See https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-web-distributions`,
    );
  }
  /**
   * Optionally prepends base path to given path pattern.
   *
   * A trailing slash on `pathPattern` is load-bearing and survives, which is why
   * this concatenates rather than going through `joinPath`. `pathPatternsFor`
   * emits both "pricing" and "pricing/" for a `trailingSlash` app, and
   * normalizing the second one collapsed it onto the first: `addBehavior` was
   * then called twice with `/base/pricing`, which CloudFront rejects at deploy
   * ("more than one cache behavior has the same path pattern"), and the
   * canonical `/base/pricing/` was left to the `/base/*` catch-all — the misroute
   * the second pattern exists to prevent.
   */
  private getPathPattern(pathPattern: string) {
    if (!this.basePath) {
      return pathPattern;
    }
    return `/${this.basePath}/${pathPattern.replace(/^\/+/, "")}`;
  }
}

/** CloudFront's per-distribution cache behavior limit, including the default. */
const MAX_CACHE_BEHAVIORS = 25;

/**
 * Rank a CloudFront path pattern so the most specific is added first: literal
 * segments before the first `*` dominate, then total segments, then length.
 *
 * Ranking on the leading literal is what a CloudFront wildcard forces, because it
 * matches across `/` rather than within one segment — so a pattern with an
 * interior wildcard is far wider than its length suggests. Writing the wildcard as
 * `<*>` to keep it out of this comment's way: an exact route's Pages Router data
 * pattern, `_next/data/<*>/pricing.json`, also matches
 * `/_next/data/<buildId>/docs/pricing.json`, and ranking it by total length put it
 * ahead of `_next/data/<*>/docs/<*>` — sending a request for the second group's
 * data URL to the first group's function, which has no entrypoint for it. Counting
 * the literal prefix first keeps the two data patterns tied there and lets segment
 * depth decide, while still ranking an exact `a/b` above the subtree `a/<*>` that
 * would otherwise swallow it.
 *
 * Residual, and not fixable with CloudFront's two wildcards: an exact route's data
 * pattern still over-matches a *default-group* route of the same leaf name
 * (`/docs/pricing` with `/pricing` in a group). Give that subtree a group of its
 * own if it comes up.
 */
function behaviorSpecificity(pattern: string): number {
  const segments = pattern.split("/").filter(Boolean);
  const firstWildcard = segments.findIndex((segment) => segment.includes("*"));
  const literalDepth = firstWildcard === -1 ? segments.length : firstWildcard;
  return literalDepth * 1000000 + segments.length * 10000 + pattern.length;
}

/**
 * CloudFront's path pattern alphabet: `A-Z a-z 0-9 _ - . * $ / ~ " ' @ : +` and
 * `&`, plus the `?` wildcard. No space, no `%`, nothing non-ASCII.
 *
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html#DownloadDistValuesPathPattern
 */
const PATH_PATTERN_CHAR = /^[a-zA-Z0-9_\-.*$/~"'@:+?&]$/;
/** CloudFront's path pattern length limit. */
const MAX_PATH_PATTERN_LENGTH = 255;

/**
 * A `public/` entry's name as a CloudFront path pattern.
 *
 * `public/hello world.jpg` is a valid Next.js asset — `next start` serves it, and
 * `next/image` points at it — but a space cannot appear in a path pattern, so
 * cdk-nextjs used to throw at synth and the app could not be deployed at all
 * (`next-image-legacy/unicode`, whose `public/` also holds `äöüščří.png`).
 *
 * CloudFront URL-decodes the request path before matching it, so the pattern is
 * matched against `hello world.jpg`, not the `/hello%20world.jpg` on the wire.
 * Each character outside the alphabet is replaced by one `?` per byte of its
 * UTF-8 encoding, because that is what `?` matches: `hello?world.jpg` for the
 * space, and two `?` for each character of `äöüščří.png`. Measured against a
 * deployed distribution; a `?` per *percent-encoded* character (`hello???world`)
 * synthesizes fine and never matches. A `*` would be shorter and much wider:
 * `äöüščří.png` would become `*.png`, which would pull every `.png` request in
 * the app onto the static origin.
 */
function toPathPattern(name: string): string {
  const pattern = [...name]
    .map((char) =>
      PATH_PATTERN_CHAR.test(char)
        ? char
        : "?".repeat(Buffer.byteLength(char, "utf8")),
    )
    .join("");
  if (pattern.length > MAX_PATH_PATTERN_LENGTH) {
    throw new Error(
      `The public/ entry "${name}" needs a ${pattern.length}-character ` +
        `CloudFront path pattern, over the ${MAX_PATH_PATTERN_LENGTH}-character ` +
        "limit. Rename it, or move it into a subdirectory of public/ whose own " +
        "name is short enough. See " +
        "https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html#DownloadDistValuesPathPattern",
    );
  }
  return pattern;
}
