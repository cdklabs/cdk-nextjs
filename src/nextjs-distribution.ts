import { CfnOutput, Duration, Stack } from "aws-cdk-lib";
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
  LoadBalancerV2Origin,
  LoadBalancerV2OriginProps,
  S3BucketOrigin,
} from "aws-cdk-lib/aws-cloudfront-origins";
import { ILoadBalancerV2 } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { IFunctionUrl } from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { NextjsType } from "./common";
import { OptionalDistributionProps } from "./generated-structs/OptionalDistributionProps";
import { OptionalS3OriginBucketWithOACProps } from "./generated-structs/OptionalS3OriginBucketWithOACProps";
import { PublicDirEntry } from "./nextjs-build/nextjs-build";

export interface NextjsDistributionOverrides {
  readonly distributionProps?: OptionalDistributionProps;
  readonly imageBehaviorOptions?: AddBehaviorOptions;
  readonly imageCachePolicyProps?: CachePolicyProps;
  readonly imageResponseHeadersPolicyProps?: ResponseHeadersPolicyProps;
  readonly dynamicBehaviorOptions?: AddBehaviorOptions;
  readonly dynamicCachePolicyProps?: CachePolicyProps;
  readonly dynamicResponseHeadersPolicyProps?: ResponseHeadersPolicyProps;
  readonly dynamicFunctionUrlOriginWithOACProps?: FunctionUrlOriginWithOACProps;
  readonly dynamicLoadBalancerV2OriginProps?: LoadBalancerV2OriginProps;
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
  readonly loadBalancer?: ILoadBalancerV2;
  readonly nextjsType: NextjsType;
  /**
   * Override props for every construct.
   */
  readonly overrides?: NextjsDistributionOverrides;
  /**
   * Path to directory of Next.js app's public directory. Used to add static
   * behaviors to distribution.
   */
  readonly publicDirEntries: PublicDirEntry[];
}

export class NextjsDistribution extends Construct {
  distribution: Distribution;

  private props: NextjsDistributionProps;
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
    new CfnOutput(this, "DistributionDomainName", {
      value: this.distribution.domainName,
    });
  }

  private createStaticOrigin(): IOrigin {
    const s3Origin = S3BucketOrigin.withOriginAccessControl(
      this.props.assetsBucket,
      this.props.overrides?.s3BucketOriginProps,
    );
    return s3Origin;
  }
  private createDynamicOrigin(): IOrigin {
    if (this.isFunctionCompute) {
      if (!this.props.functionUrl)
        throw new Error("Missing NextjsDistributionProps.functionUrl");
      return FunctionUrlOrigin.withOriginAccessControl(
        this.props.functionUrl,
        this.props.overrides?.dynamicFunctionUrlOriginWithOACProps,
      );
    } else {
      const loadBalancer = this.props.loadBalancer;
      if (!loadBalancer)
        throw new Error("Missing NextjsDistributionProps.loadBalancer");
      // TODO: use VPC Origin when L3 construct released
      return new LoadBalancerV2Origin(loadBalancer, {
        protocolPolicy: this.props.certificate
          ? OriginProtocolPolicy.HTTPS_ONLY
          : OriginProtocolPolicy.HTTP_ONLY,
        ...this.props.overrides?.dynamicLoadBalancerV2OriginProps,
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
   * compute option (App Runner, Fargate, or Lambda)
   * @see https://open-next.js.org/advanced/workaround#workaround-set-x-forwarded-host-header-aws-specific
   */
  private createDynamicCloudFrontFunctionAssociations(): FunctionAssociation[] {
    const associations: FunctionAssociation[] = [];
    if (this.isFunctionCompute) {
      const cloudFrontFn = new CloudFrontFunction(this, "CloudFrontFn", {
        code: FunctionCode.fromInline(`
          function handler(event) {
            var request = event.request;
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
        comment: `Nextjs Static Response Headers Policy for ${Stack.of(this).stackName}`,
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
          "accept",
          "rsc",
          "next-router-prefetch",
          "next-router-state-tree",
          "next-url",
          "x-prerender-revalidate",
        ),
        cookieBehavior: CacheCookieBehavior.all(),
        enableAcceptEncodingBrotli: true,
        enableAcceptEncodingGzip: true,
        comment: `Nextjs Dynamic Cache Policy for ${Stack.of(this).stackName}`,
        ...this.props.overrides?.dynamicCachePolicyProps,
      });
    const responseHeadersPolicy =
      dynamicBehaviorOptions?.responseHeadersPolicy ??
      new ResponseHeadersPolicy(this, "DynamicResponseHeadersPolicy", {
        securityHeadersBehavior: this.commonSecurityHeadersBehavior,
        comment: `Nextjs Dynamic Response Headers Policy for ${Stack.of(this).stackName}`,
        ...this.props.overrides?.dynamicBehaviorOptions?.responseHeadersPolicy,
      });
    const behaviorOptions: BehaviorOptions = {
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachePolicy,
      functionAssociations: this.dynamicCloudFrontFunctionAssociations,
      origin: this.dynamicOrigin,
      originRequestPolicy: this.dynamicOriginResponsePolicy,
      responseHeadersPolicy,
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      ...dynamicBehaviorOptions,
    };
    return behaviorOptions;
  }
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
        comment: `Nextjs Image Cache Policy for ${Stack.of(this).stackName}`,
        ...this.props.overrides?.imageCachePolicyProps,
      });
    // add default response headers policy if not provided
    const responseHeadersPolicy =
      imageBehaviorOptions?.responseHeadersPolicy ??
      new ResponseHeadersPolicy(this, "ImageResponseHeadersPolicy", {
        securityHeadersBehavior: this.commonSecurityHeadersBehavior,
        comment: `Nextjs Image Response Headers Policy for ${Stack.of(this).stackName}`,
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
        comment: `cdk-nextjs Distribution for ${Stack.of(this).stackName}`,
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
    // Root Path Behaviors
    if (this.props.basePath) {
      // because we already have a basePath we don't use / instead we use /base-path
      this.distribution.addBehavior(
        this.props.basePath,
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
  private addStaticBehaviors() {
    this.distribution.addBehavior(
      "_next/static*",
      this.staticOrigin,
      this.staticBehaviorOptions,
    );
    // 22 = 25 (max) - 1 (_next/image) - 1 (_next/static) - 1 (*)
    if (this.props.publicDirEntries.length >= 22) {
      throw new Error(
        `Too many public/ files in Next.js build. CloudFront limits Distributions to 25 Cache Behaviors. See documented limit here: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-web-distributions. Try including all public files into 1 top level directory (i.e. static/*).`,
      );
    }
    for (const publicFile of this.props.publicDirEntries) {
      const pathPattern = publicFile.isDirectory
        ? `${publicFile.name}/*`
        : publicFile.name;
      if (!/^[a-zA-Z0-9_\-.*$/~"'@:+?&]+$/.test(pathPattern)) {
        throw new Error(
          `Invalid CloudFront Distribution Cache Behavior Path Pattern: ${pathPattern}. Please see documentation here: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-web-values-specify.html#DownloadDistValuesPathPattern`,
        );
      }
      const finalPathPattern = this.getPathPattern(pathPattern);
      this.distribution.addBehavior(
        finalPathPattern,
        this.staticOrigin,
        this.staticBehaviorOptions,
      );
    }
  }
  /**
   * Optionally prepends base path to given path pattern.
   */
  private getPathPattern(pathPattern: string) {
    if (this.props.basePath) {
      return `${this.props.basePath}/${pathPattern}`;
    } else {
      return pathPattern;
    }
  }
}
