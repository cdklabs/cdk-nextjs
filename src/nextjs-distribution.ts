import { Annotations, Duration, Stack, Token } from "aws-cdk-lib";
import { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  AccessLevel,
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
  FunctionProps,
  FunctionRuntime,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  IKeyValueStore,
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
import { CfnPermission, IFunctionUrl } from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import {
  assertKnownFunctionGroups,
  DEFAULT_FUNCTION_GROUP,
} from "./adapter/function-groups";
import { LOG_PREFIX, NextjsType } from "./constants";
import { OptionalDistributionProps } from "./generated-structs/OptionalDistributionProps";
import { OptionalS3OriginBucketWithOACProps } from "./generated-structs/OptionalS3OriginBucketWithOACProps";
import {
  NextjsFunctionGroupBehavior,
  PublicDirEntry,
} from "./nextjs-build/nextjs-build";
import { assetPrefixPath, normalizeBasePath } from "./utils/base-path";
import {
  assertBehaviorBudget,
  DEFAULT_MAX_CACHE_BEHAVIORS,
} from "./utils/behavior-budget";
import {
  DISABLED_CACHE_KEY,
  DYNAMIC_CACHE_KEY,
  isCachingDisabled,
} from "./utils/cache-keys";
import {
  assertNoPublicCollisions,
  getPathPattern,
  publicPathPatterns,
} from "./utils/path-patterns";
import {
  assertViewerRequestUnclaimed,
  assetPrefixRewriteHandler,
  checkFunctionCodeSize,
  checkViewerRequestCode,
  MAX_FUNCTION_CODE_BYTES,
  PASS_THROUGH_HANDLER,
  spliceViewerRequest,
  X_FORWARDED_HOST_HANDLER,
} from "./utils/viewer-request-functions";

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
   * @default - none; pass `NextjsBuild.nextConfigAssetPrefixPath`
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
   * The `Service-Worker-Allowed` header for `_next/static/service-worker/*`,
   * which Next.js sends so a compiled service worker can register at a scope
   * wider than its own directory, such as `/`. S3 can't send an arbitrary
   * header, so setting this adds a behavior for those files whose response
   * headers policy does. Next.js uses the app's `basePath`, or `/` for none.
   * @default - no behavior; the build has no service worker
   */
  readonly serviceWorkerAllowed?: string;
  /**
   * The non-`default` function groups, the origins
   * {@link functionGroupBehaviors} route to.
   * @default - no splitting; the default behavior serves every dynamic route
   */
  readonly functionGroups?: NextjsDistributionFunctionGroup[];
  /**
   * `NextjsBuild.functionGroupBehaviors`: one cache behavior each, added in
   * order, so the routes each group was packaged with reach it rather than the
   * default function.
   * @default - none
   */
  readonly functionGroupBehaviors?: NextjsFunctionGroupBehavior[];
  /**
   * The most cache behaviors the distribution may have, the default one
   * included. cdk-nextjs counts what it adds against this at synth, so running
   * out is a synth error naming what used them rather than a failed deploy.
   *
   * Raise it after raising the "Cache behaviors per distribution" quota for
   * your account. Lower it by the behaviors a supplied {@link distribution}
   * (or `overrides.distributionProps`) already has, which are not counted.
   * @default 75 - CloudFront's default quota
   * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-web-distributions
   */
  readonly maxCacheBehaviors?: number;
  /**
   * CloudFront Function code run first on every viewer request, on every
   * behavior cdk-nextjs adds, static assets included — HTTP Basic auth on a
   * pre-launch site, geo-gating.
   *
   * It must define `viewerRequest(event)` (a function, sync or async, or a
   * `var`/`let`/`const`): return a response to answer the viewer, or the
   * request (or nothing) to carry on. It is spliced into cdk-nextjs's own
   * viewer-request functions, ahead of their logic, so it may not use the
   * name `handler`, and the combined function must fit CloudFront's 10 KB.
   * It runs on `cloudfront-js-2.0`, so it may be async and read
   * {@link viewerRequestKeyValueStore} with `cf.kvs()`. A bring-your-own
   * {@link distribution}'s default behavior isn't covered.
   *
   * @default - none
   * @see https://github.com/cdklabs/cdk-nextjs#running-code-on-every-viewer-request
   */
  readonly viewerRequestFunctionCode?: FunctionCode;
  /**
   * A CloudFront KeyValueStore associated with every viewer-request function
   * {@link viewerRequestFunctionCode} is copied into (up to three, one per kind
   * of behavior), so values it reads — Basic auth credentials, an allowlist —
   * live outside the CloudFormation template and change without a deploy.
   * Read it with `cf.kvs()`, no ID needed.
   * @default - none
   * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-custom-methods.html
   */
  readonly viewerRequestKeyValueStore?: IKeyValueStore;
}

/** A non-default function group and the origin its routes must reach. */
export interface NextjsDistributionFunctionGroup {
  readonly name: string;
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
  /**
   * `viewerRequestFunctionCode`, rendered and checked once, since
   * `FunctionCode.fromFile` reads the file on every render.
   */
  private viewerRequestCode?: string;
  /**
   * The viewer-request function `viewerRequestFunctionCode` adds to behaviors
   * with no viewer-request logic of their own, shared by all of them, so the
   * `assetPrefix` behavior, which has a viewer-request function of its own,
   * can tell it from an override's.
   */
  private passThroughFunction?: CloudFrontFunction;
  private isFunctionCompute: boolean;
  private staticBehaviorOptions: BehaviorOptions;
  private dynamicBehaviorOptions: BehaviorOptions;
  private imageBehaviorOptions: BehaviorOptions;

  constructor(scope: Construct, id: string, props: NextjsDistributionProps) {
    super(scope, id);
    this.props = props;
    if (props.viewerRequestKeyValueStore && !props.viewerRequestFunctionCode) {
      throw new Error(
        `${LOG_PREFIX} \`viewerRequestKeyValueStore\` is only associated with ` +
          `the functions \`viewerRequestFunctionCode\` runs in, so it needs ` +
          `\`viewerRequestFunctionCode\` to read it.`,
      );
    }
    this.viewerRequestCode = this.renderViewerRequestCode();
    this.basePath = normalizeBasePath(props.basePath);
    this.assetPrefix = this.resolveAssetPrefix();
    this.staticOrigin = this.createStaticOrigin();
    this.isFunctionCompute = props.nextjsType === NextjsType.GLOBAL_FUNCTIONS;
    this.validateFunctionGroupProps();
    this.dynamicOrigin = this.createDynamicOrigin();
    this.dynamicOriginResponsePolicy = this.createDynamicOriginRequestPolicy();
    this.dynamicCloudFrontFunctionAssociations =
      this.createDynamicCloudFrontFunctionAssociations();
    this.staticBehaviorOptions = this.createStaticBehaviorOptions();
    this.dynamicBehaviorOptions = this.createDynamicBehaviorOptions();
    this.imageBehaviorOptions = this.createImageBehaviorOptions();
    this.distribution = this.getDistribution();
    if (this.isFunctionCompute) {
      this.grantInvoke(DEFAULT_FUNCTION_GROUP, props.functionUrl!);
    }
    this.addStaticBehaviors();
    this.addDynamicBehaviors();
  }

  /**
   * Creates a CloudFront comment that is safe for the 128 character limit.
   * If the full comment with stack name exceeds 128 characters, returns the base comment only.
   * @param baseComment The base comment text
   * @returns A comment string that is guaranteed to be at most 128 characters
   */
  private getComment(baseComment: string): string {
    const fullComment = `${baseComment} for ${Stack.of(this).stackName}`;
    return fullComment.length <= 128 ? fullComment : baseComment;
  }

  /**
   * A response headers policy with {@link commonSecurityHeadersBehavior}, for a
   * behavior whose override supplies none.
   */
  private responseHeadersPolicy(
    id: string,
    comment: string,
    overrideProps: ResponseHeadersPolicyProps | undefined,
  ): ResponseHeadersPolicy {
    return new ResponseHeadersPolicy(this, id, {
      securityHeadersBehavior: this.commonSecurityHeadersBehavior,
      comment: this.getComment(comment),
      ...overrideProps,
    });
  }
  private createStaticOrigin(): IOrigin {
    return S3BucketOrigin.withOriginAccessControl(this.props.assetsBucket, {
      // LIST lets S3 answer a missing key with 404 instead of 403
      originAccessLevels: [AccessLevel.READ, AccessLevel.LIST],
      ...this.props.overrides?.s3BucketOriginProps,
    });
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
   *
   * A container origin also gets CloudFront's own headers, for
   * `CloudFront-Forwarded-Proto`: without a certificate CloudFront reaches the
   * ALB over plain HTTP, so the ALB's `X-Forwarded-Proto` is `http`, and the
   * runtime would build every absolute URL (`request.url`, the origin a server
   * action is forwarded to) as `http://` behind a viewer on HTTPS.
   * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html#managed-origin-request-policy-all-viewer-except-host-header
   * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html#managed-origin-request-policy-all-viewer-and-cloudfront
   */
  private createDynamicOriginRequestPolicy(): IOriginRequestPolicy {
    return this.isFunctionCompute
      ? OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER
      : OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022;
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
        ...this.viewerRequestFunctionProps(X_FORWARDED_HOST_HANDLER),
      });
      associations.push({
        eventType: FunctionEventType.VIEWER_REQUEST,
        function: cloudFrontFn,
      });
    } else if (this.viewerRequestCode !== undefined) {
      // Containers need no function of their own — their origin sees the
      // viewer's `Host` — so this one only runs the user's code.
      associations.push({
        eventType: FunctionEventType.VIEWER_REQUEST,
        function: this.getPassThroughFunction(),
      });
    }
    return associations;
  }
  /**
   * The function a behavior with no viewer-request logic of its own gets when
   * `viewerRequestFunctionCode` is set, created on first use.
   */
  private getPassThroughFunction() {
    this.passThroughFunction ??= new CloudFrontFunction(
      this,
      "ViewerRequestFn",
      {
        comment: this.getComment("NextJS viewer request"),
        ...this.viewerRequestFunctionProps(PASS_THROUGH_HANDLER),
      },
    );
    return this.passThroughFunction;
  }
  /**
   * The code, runtime and KeyValueStore of a function whose `handler` is
   * cdk-nextjs's, with `viewerRequestFunctionCode` spliced in
   * ({@link spliceViewerRequest}) and checked against CloudFront's size limit.
   *
   * Every one runs on `cloudfront-js-2.0`, the runtime AWS recommends and the
   * one with `async` and KeyValueStores, so the handlers are all `async`
   * whether or not there is user code to await.
   */
  private viewerRequestFunctionProps(
    handler: string,
  ): Pick<FunctionProps, "code" | "runtime" | "keyValueStore"> {
    const userCode = this.viewerRequestCode;
    const code = spliceViewerRequest(handler, userCode);
    if (userCode === undefined) {
      return {
        code: FunctionCode.fromInline(code),
        runtime: FunctionRuntime.JS_2_0,
      };
    }
    if (checkFunctionCodeSize(code) === "unresolved") {
      Annotations.of(this).addWarning(
        `${LOG_PREFIX} \`viewerRequestFunctionCode\` contains a CDK token, so ` +
          `its size can't be checked against CloudFront's limit of ` +
          `${MAX_FUNCTION_CODE_BYTES} bytes until deploy.`,
      );
    }
    return {
      code: FunctionCode.fromInline(code),
      runtime: FunctionRuntime.JS_2_0,
      keyValueStore: this.props.viewerRequestKeyValueStore,
    };
  }
  /**
   * `viewerRequestFunctionCode`, rendered once, since `FunctionCode.fromFile`
   * reads the file on every render, and checked
   * ({@link checkViewerRequestCode}).
   */
  private renderViewerRequestCode(): string | undefined {
    const userCode = this.props.viewerRequestFunctionCode?.render();
    if (userCode === undefined) {
      return undefined;
    }
    checkViewerRequestCode(userCode);
    return userCode;
  }
  private createStaticBehaviorOptions(): BehaviorOptions {
    const staticBehaviorOptions = this.props.overrides?.staticBehaviorOptions;
    const responseHeadersPolicy =
      staticBehaviorOptions?.responseHeadersPolicy ??
      this.responseHeadersPolicy(
        "StaticResponseHeadersPolicy",
        "NextJS Static Response Headers Policy",
        this.props.overrides?.staticResponseHeadersPolicyProps,
      );
    const options: BehaviorOptions = {
      allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
      cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      origin: this.staticOrigin,
      responseHeadersPolicy,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      ...staticBehaviorOptions,
    };
    if (this.viewerRequestCode === undefined) {
      return options;
    }
    assertViewerRequestUnclaimed(
      "staticBehaviorOptions",
      staticBehaviorOptions?.functionAssociations,
      "`viewerRequestFunctionCode` needs that event type on the static behaviors",
    );
    return {
      ...options,
      functionAssociations: [
        ...(staticBehaviorOptions?.functionAssociations ?? []),
        {
          eventType: FunctionEventType.VIEWER_REQUEST,
          function: this.getPassThroughFunction(),
        },
      ],
    };
  }
  private createDynamicBehaviorOptions(): BehaviorOptions {
    const dynamicBehaviorOptions = this.props.overrides?.dynamicBehaviorOptions;
    const cachePolicyProps = this.props.overrides?.dynamicCachePolicyProps;
    // create default cache policy if not provided
    const cachePolicy =
      dynamicBehaviorOptions?.cachePolicy ??
      new CachePolicy(this, "DynamicCachePolicy", {
        ...(isCachingDisabled(cachePolicyProps)
          ? DISABLED_CACHE_KEY
          : DYNAMIC_CACHE_KEY),
        // A response with no `Cache-Control` is not cached, which is what Next.js
        // and every app written for it assume: a dynamic route handler sets none.
        // CDK's default is a day, which cached `/api/*` responses at the edge for
        // 24 hours. Anything Next.js *means* to cache - ISR, SSG, a PPR shell -
        // says so with `s-maxage`, which `maxTtl` still honors.
        defaultTtl: Duration.seconds(0),
        comment: this.getComment("NextJS Dynamic Cache Policy"),
        ...cachePolicyProps,
      });
    const responseHeadersPolicy =
      dynamicBehaviorOptions?.responseHeadersPolicy ??
      this.responseHeadersPolicy(
        "DynamicResponseHeadersPolicy",
        "NextJS Dynamic Response Headers Policy",
        this.props.overrides?.dynamicResponseHeadersPolicyProps,
      );
    return {
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy,
      origin: this.dynamicOrigin,
      originRequestPolicy: this.dynamicOriginResponsePolicy,
      responseHeadersPolicy,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      ...dynamicBehaviorOptions,
      functionAssociations: this.withDynamicFunctionAssociations(
        "dynamicBehaviorOptions",
        dynamicBehaviorOptions?.functionAssociations,
      ),
    };
  }
  /**
   * The behavior's function associations: an override's, plus the viewer-request
   * function Global Functions depends on, or the one `viewerRequestFunctionCode`
   * adds on Global Containers.
   *
   * Spreading the override's `functionAssociations` over ours would silently
   * drop that function, and with it the only thing standing between a viewer's
   * own `X-Forwarded-Host` and the runtime, which trusts that header on Function
   * URL events (`lambda-event.ts`): host injection into redirects and absolute
   * URLs, cached for other viewers because the header is not in the cache key.
   * So ours is kept, and an override claiming VIEWER_REQUEST — which CloudFront
   * allows only one of per behavior — is an error rather than a replacement.
   */
  private withDynamicFunctionAssociations(
    overrideName: string,
    overridden: FunctionAssociation[] | undefined,
  ): FunctionAssociation[] {
    const ours = this.dynamicCloudFrontFunctionAssociations;
    if (!overridden) {
      return ours;
    }
    if (!ours.length) {
      return overridden;
    }
    assertViewerRequestUnclaimed(
      overrideName,
      overridden,
      this.isFunctionCompute
        ? `NextjsGlobalFunctions needs that event type for its own function, ` +
            `which overwrites \`x-forwarded-host\` with the viewer's \`Host\` ` +
            `(the runtime trusts that header behind CloudFront) and redirects ` +
            `repeated slashes`
        : "`viewerRequestFunctionCode` needs that event type on the dynamic " +
            "and image behaviors",
    );
    return [...overridden, ...ours];
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
        comment: this.getComment("NextJS Image Cache Policy"),
        ...this.props.overrides?.imageCachePolicyProps,
      });
    // add default response headers policy if not provided
    const responseHeadersPolicy =
      imageBehaviorOptions?.responseHeadersPolicy ??
      this.responseHeadersPolicy(
        "ImageResponseHeadersPolicy",
        "NextJS Image Response Headers Policy",
        this.props.overrides?.imageResponseHeadersPolicyProps,
      );
    return {
      allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
      origin: this.dynamicOrigin,
      originRequestPolicy: this.dynamicOriginResponsePolicy,
      cachePolicy,
      responseHeadersPolicy,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      ...imageBehaviorOptions,
      functionAssociations: this.withDynamicFunctionAssociations(
        "imageBehaviorOptions",
        imageBehaviorOptions?.functionAssociations,
      ),
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
      // Under a `basePath`, the behaviors cdk-nextjs adds for it serve the
      // app, so the default behavior is the user's to replace.
      if (
        this.viewerRequestCode !== undefined &&
        !this.basePath &&
        this.props.overrides?.distributionProps?.defaultBehavior
      ) {
        throw new Error(
          `${LOG_PREFIX} \`overrides.distributionProps.defaultBehavior\` ` +
            `replaces the default behavior cdk-nextjs builds, and with it the ` +
            `viewer-request function \`viewerRequestFunctionCode\` runs in, ` +
            `so pages and API routes would skip it. Customize the default ` +
            `behavior through \`overrides.dynamicBehaviorOptions\` instead.`,
        );
      }
      distribution = new Distribution(this, "Distribution", {
        minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
        defaultBehavior: this.dynamicBehaviorOptions,
        // best to use HTTP 2 and 3 for compatability (HTTP 2) and performance (HTTP3)
        // CloudFront will choose best option for client
        httpVersion: HttpVersion.HTTP2_AND_3,
        comment: this.getComment("NextJS Distribution"),
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
  /**
   * Before any behavior is computed: the budget and the `public/` checks both
   * generate the group patterns, and would otherwise fail first with a less
   * useful message.
   */
  private validateFunctionGroupProps() {
    if (
      !this.props.functionGroups?.length &&
      !this.props.functionGroupBehaviors?.length
    ) {
      return;
    }
    if (!this.isFunctionCompute) {
      throw new Error(
        "`functionGroups` is only supported by NextjsGlobalFunctions.",
      );
    }
  }
  /**
   * Every group behavior, final path pattern included, in the order
   * {@link addFunctionGroupBehaviors} adds them.
   */
  private functionGroupBehaviors() {
    const groups = this.props.functionGroups ?? [];
    const behaviors = this.props.functionGroupBehaviors ?? [];
    assertKnownFunctionGroups(groups, behaviors);
    return behaviors.map((behavior) => ({
      ...behavior,
      group: groups.find((it) => it.name === behavior.group)!,
      pathPattern: this.getPathPattern(behavior.pattern),
    }));
  }
  /**
   * One behavior per group pattern, most specific first.
   *
   * The order is the whole mechanism. CloudFront evaluates behaviors in order
   * and stops at the first whose path pattern matches, and `addBehavior`
   * appends — so `api/*` added before `api/reports/*` would swallow every
   * report request and send it to a function whose package has no report
   * entrypoint. The adapter sorted the list when it checked it against how
   * `assignRoutesToGroups` packaged the same routes, so it is added as it is.
   */
  private addFunctionGroupBehaviors() {
    const originPerGroup = new Map<string, IOrigin>();
    for (const { group, pathPattern } of this.functionGroupBehaviors()) {
      let origin = originPerGroup.get(group.name);
      if (!origin) {
        origin = FunctionUrlOrigin.withOriginAccessControl(
          group.functionUrl,
          this.props.overrides?.dynamicFunctionUrlOriginWithOACProps,
        );
        originPerGroup.set(group.name, origin);
        this.grantInvoke(group.name, group.functionUrl);
      }
      // Same behavior options as every other dynamic route — only the origin
      // differs, and it is passed separately.
      const { origin: _ignored, ...behaviorOptions } =
        this.dynamicBehaviorOptions;
      this.distribution.addBehavior(pathPattern, origin, behaviorOptions);
    }
  }
  /**
   * `lambda:InvokeFunction` for CloudFront, which a Function URL behind OAC
   * needs besides the `lambda:InvokeFunctionUrl` `FunctionUrlOrigin` grants,
   * and scoped the same way: to this distribution, and to calls that come
   * through the Function URL.
   */
  private grantInvoke(group: string, functionUrl: IFunctionUrl) {
    new CfnPermission(this, `InvokeFunction-${group}`, {
      action: "lambda:InvokeFunction",
      principal: "cloudfront.amazonaws.com",
      functionName: functionUrl.functionArn,
      sourceArn: this.distribution.distributionArn,
      invokedViaFunctionUrl: true,
    });
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
    // The static behaviors' own viewer-request function, when
    // `viewerRequestFunctionCode` added one, gives way to the rewrite, which
    // runs the same code first.
    const associations = (
      this.staticBehaviorOptions.functionAssociations ?? []
    ).filter(
      (association) => association.function !== this.passThroughFunction,
    );
    assertViewerRequestUnclaimed(
      "staticBehaviorOptions",
      associations,
      `serving \`assetPrefix\` ("${this.assetPrefix}") needs that event type ` +
        `to rewrite the request URI to the object's key`,
    );
    const rewrite = new CloudFrontFunction(this, "AssetPrefixFn", {
      comment: this.getComment("NextJS assetPrefix rewrite"),
      ...this.viewerRequestFunctionProps(
        assetPrefixRewriteHandler(this.basePath, this.assetPrefix),
      ),
    });
    this.distribution.addBehavior(
      `${this.assetPrefix}/_next/static*`,
      this.staticOrigin,
      {
        ...this.staticBehaviorOptions,
        functionAssociations: [
          ...associations,
          { eventType: FunctionEventType.VIEWER_REQUEST, function: rewrite },
        ],
      },
    );
  }
  /**
   * Serves `_next/static/service-worker/*` with `Service-Worker-Allowed`, which
   * the browser requires before it registers a service worker at a scope above
   * the script's own directory. Added ahead of `_next/static*`, which would
   * otherwise match first.
   *
   * The policy is the static one plus the header, so security headers and any
   * `staticResponseHeadersPolicyProps` still apply. A whole
   * `staticBehaviorOptions.responseHeadersPolicy` can't be added to, so it is
   * used as it is, with a warning.
   */
  private addServiceWorkerBehavior(serviceWorkerAllowed: string) {
    const overridden =
      this.props.overrides?.staticBehaviorOptions?.responseHeadersPolicy;
    if (overridden) {
      Annotations.of(this).addWarning(
        `${LOG_PREFIX} \`overrides.staticBehaviorOptions.responseHeadersPolicy\` ` +
          `is used for \`_next/static/service-worker/*\` too, so service ` +
          `workers get no \`Service-Worker-Allowed: ${serviceWorkerAllowed}\` ` +
          `unless that policy sends it, and registering one at a scope above ` +
          `its own directory fails. Add the header to your policy, or set ` +
          `\`overrides.staticResponseHeadersPolicyProps\` instead.`,
      );
    }
    const props = this.props.overrides?.staticResponseHeadersPolicyProps;
    const customHeaders = props?.customHeadersBehavior?.customHeaders ?? [];
    const responseHeadersPolicy =
      overridden ??
      new ResponseHeadersPolicy(this, "ServiceWorkerResponseHeadersPolicy", {
        securityHeadersBehavior: this.commonSecurityHeadersBehavior,
        comment: this.getComment(
          "NextJS Service Worker Response Headers Policy",
        ),
        ...props,
        // Policy names are unique per account, so the static policy's can't be
        // reused as it is, and are at most 128 characters, so a suffix can't
        // simply be added to one that is already that long.
        responseHeadersPolicyName:
          props?.responseHeadersPolicyName &&
          `${
            Token.isUnresolved(props.responseHeadersPolicyName)
              ? props.responseHeadersPolicyName
              : props.responseHeadersPolicyName.slice(
                  0,
                  MAX_POLICY_NAME_LENGTH - SERVICE_WORKER_SUFFIX.length,
                )
          }${SERVICE_WORKER_SUFFIX}`,
        customHeadersBehavior: {
          // One the override sets itself is kept.
          customHeaders: customHeaders.some(
            ({ header }) => header.toLowerCase() === "service-worker-allowed",
          )
            ? customHeaders
            : [
                ...customHeaders,
                {
                  header: "Service-Worker-Allowed",
                  value: serviceWorkerAllowed,
                  override: true,
                },
              ],
        },
      });
    this.distribution.addBehavior(
      this.getPathPattern("_next/static/service-worker/*"),
      this.staticOrigin,
      { ...this.staticBehaviorOptions, responseHeadersPolicy },
    );
  }
  private addStaticBehaviors() {
    if (this.props.serviceWorkerAllowed !== undefined) {
      this.addServiceWorkerBehavior(this.props.serviceWorkerAllowed);
    }
    this.distribution.addBehavior(
      this.getPathPattern("_next/static*"),
      this.staticOrigin,
      this.staticBehaviorOptions,
    );
    if (this.assetPrefix) {
      this.addAssetPrefixBehavior();
    }
    const { patterns, unmatchable } = publicPathPatterns(
      this.props.publicDirEntries,
      this.basePath,
    );
    if (unmatchable.length > 0) {
      Annotations.of(this).addWarning(
        `${LOG_PREFIX} These top-level public/ entries have no character a ` +
          "CloudFront path pattern can spell, so their pattern would be " +
          "wildcards alone and would capture every app route of the same " +
          `length. They get no behavior, so their requests reach the server, ` +
          `which reads them from S3 instead: ` +
          `${unmatchable.map((name) => `"${name}"`).join(", ")}. To serve ` +
          "them from S3 directly, rename them, or move them into a public/ " +
          "subdirectory whose name has at least one ASCII letter or digit.",
      );
    }
    const groupBehaviors = this.functionGroupBehaviors();
    assertBehaviorBudget({
      limit: this.props.maxCacheBehaviors ?? DEFAULT_MAX_CACHE_BEHAVIORS,
      basePath: this.basePath,
      assetPrefix: this.assetPrefix,
      serviceWorker: this.props.serviceWorkerAllowed !== undefined,
      publicPatterns: patterns.length,
      groupPatterns: groupBehaviors.length,
    });
    assertNoPublicCollisions(patterns, groupBehaviors);
    for (const pathPattern of patterns) {
      this.distribution.addBehavior(
        pathPattern,
        this.staticOrigin,
        this.staticBehaviorOptions,
      );
    }
  }
  /** {@link getPathPattern} under this distribution's `basePath`. */
  private getPathPattern(pathPattern: string) {
    return getPathPattern(this.basePath, pathPattern);
  }
}

/**
 * CloudFront's limit on a response headers policy name, and the suffix that
 * tells the service worker policy's apart from the static one's.
 * @see https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_ResponseHeadersPolicyConfig.html
 */
const MAX_POLICY_NAME_LENGTH = 128;
const SERVICE_WORKER_SUFFIX = "-sw";
