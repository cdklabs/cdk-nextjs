import { CfnOutput, Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
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
  LambdaEdgeEventType,
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
  FunctionUrlOriginProps,
  HttpOrigin,
  HttpOriginProps,
  S3BucketOrigin,
} from "aws-cdk-lib/aws-cloudfront-origins";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { IFunctionUrl } from "aws-cdk-lib/aws-lambda";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { NextjsType } from "./common";
import { OptionalDistributionProps } from "./generated-structs/OptionalDistributionProps";
import { OptionalFunctionProps } from "./generated-structs/OptionalFunctionProps";
import { OptionalS3OriginBucketWithOACProps } from "./generated-structs/OptionalS3OriginBucketWithOACProps";
import { SignFnUrlFunction } from "./lambdas/sign-fn-url/sign-fn-url-function";
import { PublicDirEntry } from "./nextjs-build/nextjs-build";

export interface NextjsDistributionOverrides {
  readonly edgeFunctionProps?: OptionalFunctionProps;
  readonly distributionProps?: OptionalDistributionProps;
  readonly imageBehaviorOptions?: AddBehaviorOptions;
  readonly imageCachePolicyProps?: CachePolicyProps;
  readonly imageResponseHeadersPolicyProps?: ResponseHeadersPolicyProps;
  readonly dynamicBehaviorOptions?: AddBehaviorOptions;
  readonly dynamicCachePolicyProps?: CachePolicyProps;
  readonly dynamicResponseHeadersPolicyProps?: ResponseHeadersPolicyProps;
  readonly serverOriginProps?: HttpOriginProps & FunctionUrlOriginProps;
  readonly imageOriginProps?: HttpOriginProps & FunctionUrlOriginProps;
  readonly staticBehaviorOptions?: AddBehaviorOptions;
  readonly staticResponseHeadersPolicyProps?: ResponseHeadersPolicyProps;
  readonly s3OriginProps?: OptionalS3OriginBucketWithOACProps;
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
   * * Required if `NextjsType.GLOBAL_CONTAINERS` or `NextjsType.REGIONAL_CONTAINERS`
   */
  readonly loadBalancerDomainName?: string;
  /**
   * Required if `NextjsType.GLOBAL_FUNCTIONS`
   */
  readonly serverFunctionUrl?: IFunctionUrl;
  /**
   * Required if `NextjsType.GLOBAL_FUNCTIONS`
   */
  readonly imageFunctionUrl?: IFunctionUrl;
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
  private serverOrigin: IOrigin;
  // separate image origin so that we can remove large sharp node_module from server
  private imageOrigin?: IOrigin;
  private dynamicOriginResponsePolicy: IOriginRequestPolicy;
  private dynamicCloudFrontFunctionAssociations: FunctionAssociation[];
  private edgeLambdas?: AddBehaviorOptions["edgeLambdas"];
  private isFunctionCompute: boolean;
  private staticBehaviorOptions: BehaviorOptions;
  private dynamicBehaviorOptions: BehaviorOptions;
  private imageBehaviorOptions: BehaviorOptions;

  constructor(scope: Construct, id: string, props: NextjsDistributionProps) {
    super(scope, id);
    this.props = props;
    this.staticOrigin = this.createStaticOrigin();
    this.isFunctionCompute = props.nextjsType === NextjsType.GLOBAL_FUNCTIONS;
    if (this.isFunctionCompute) {
      this.serverOrigin = this.createFunctionUrlServerOrigin();
      this.imageOrigin = this.createFunctionUrlImageOrigin();
    } else {
      this.serverOrigin = this.createHttpOrigin();
    }
    this.dynamicOriginResponsePolicy = this.createDynamicOriginRequestPolicy();
    this.dynamicCloudFrontFunctionAssociations =
      this.createDynamicCloudFrontFunctionAssociations();
    if (this.isFunctionCompute) {
      this.edgeLambdas = this.createEdgeLambdas();
    }
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
      this.props.overrides?.s3OriginProps,
    );
    return s3Origin;
  }
  private createFunctionUrlServerOrigin() {
    if (!this.props.serverFunctionUrl) {
      throw new Error(
        "serverFunctionUrl is required when NextjsType.GLOBAL_FUNCTIONS",
      );
    }
    const functionUrlOrigin = new FunctionUrlOrigin(
      this.props.serverFunctionUrl,
      this.props.overrides?.serverOriginProps,
    );
    // WAITING FOR CLOUDFRONT FEATURE: CloudFront Lambda Function URL OAC
    // doesn't support POST with body since CloudFront doesn't include sha256
    // hash of body. see: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html
    // We could monkey patch `fetch` to include sha256 in request for server
    // actions, but better solution is for cloudfront to support it
    //
    // TODO: use L2 construct when released: https://github.com/aws/aws-cdk/issues/31629
    /**
     * Given stack id: "arn:aws:cloudformation:us-east-1:905418358903:stack/lh-stickb-idp/4bf74be0-e880-11ee-aea9-0affc6185b25",
     * returns "4bf74be0"
     */
    // const uniqueStackIdPart = Fn.select(
    //   0,
    //   Fn.split("-", Fn.select(2, Fn.split("/", `${Aws.STACK_ID}`))),
    // );
    // const lambdaOac = new CfnOriginAccessControl(this, "OAC", {
    //   originAccessControlConfig: {
    //     name: `OAC-Lambda-${uniqueStackIdPart}`,
    //     originAccessControlOriginType: "lambda",
    //     signingBehavior: "always",
    //     signingProtocol: "sigv4",
    //   },
    // });
    // const cfnDistribution = this.distribution.node
    //   .defaultChild as CfnDistribution;
    // cfnDistribution.addPropertyOverride(
    //   "DistributionConfig.Origins.0.OriginAccessControlId",
    //   lambdaOac.getAtt("Id"),
    // );
    return functionUrlOrigin;
  }
  private createFunctionUrlImageOrigin() {
    if (!this.props.imageFunctionUrl) {
      throw new Error(
        "imageFunctionUrl is required when NextjsType.GLOBAL_FUNCTIONS",
      );
    }
    const functionUrlOrigin = new FunctionUrlOrigin(
      this.props.imageFunctionUrl,
      this.props.overrides?.imageOriginProps,
    );
    // TODO: see createFunctionServerOrigin giant comment above. same applies here.
    return functionUrlOrigin;
  }
  private createHttpOrigin() {
    if (!this.props.loadBalancerDomainName) {
      throw new Error(
        "loadBalancerDomainName is required when NextjsType.GLOBAL_CONTAINERS or NextjsType.REGIONAL_CONTAINERS",
      );
    }
    const protocolPolicy = this.props.certificate
      ? OriginProtocolPolicy.HTTPS_ONLY
      : OriginProtocolPolicy.HTTP_ONLY;
    return new HttpOrigin(this.props.loadBalancerDomainName, {
      protocolPolicy,
      ...this.props.overrides?.serverOriginProps,
    });
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
   * compute option (Fargate, or Lambda)
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
  /**
   * Required to sign requests so that we can use IAM_AUTH for Lambda Function URL
   * to prevent public access. Once CloudFront Lambda OAC is released, we can
   * use infra configuration for this instead of custom code.
   */
  private createEdgeLambdas(): AddBehaviorOptions["edgeLambdas"] {
    if (!this.props.serverFunctionUrl?.functionArn) {
      throw new Error("serverFunctionUrl is required");
    }
    if (!this.props.imageFunctionUrl?.functionArn) {
      throw new Error("imageFunctionUrl is required");
    }
    const edgeFn = new SignFnUrlFunction(this, "SignFnUrl", {
      initialPolicy: [
        new PolicyStatement({
          actions: ["lambda:InvokeFunctionUrl"],
          resources: [
            this.props.serverFunctionUrl.functionArn,
            this.props.imageFunctionUrl.functionArn,
          ],
        }),
      ],
      ...this.props.overrides?.edgeFunctionProps,
    });
    edgeFn.currentVersion.grantInvoke(
      new ServicePrincipal("edgelambda.amazonaws.com"),
    );
    edgeFn.currentVersion.grantInvoke(
      new ServicePrincipal("lambda.amazonaws.com"),
    );
    // retain on delete b/c they take too long to delete resulting in stack failure
    edgeFn.applyRemovalPolicy(RemovalPolicy.RETAIN);
    return [
      {
        eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
        functionVersion: edgeFn.currentVersion,
        includeBody: true,
      },
    ];
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
      edgeLambdas: this.edgeLambdas,
      functionAssociations: this.dynamicCloudFrontFunctionAssociations,
      origin: this.serverOrigin,
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
        queryStringBehavior: CacheQueryStringBehavior.all(),
        headerBehavior: CacheHeaderBehavior.allowList("accept"),
        // SECURITY NOTE: by default we don't include cookies in cache for
        // images b/c it significantly improves image perf for most sites BUT
        // if you have private images locked behind auth implemented with cookies
        // you need to override this.
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
      edgeLambdas: this.edgeLambdas,
      functionAssociations: this.dynamicCloudFrontFunctionAssociations,
      // imageOrigin will only exist for functions. if container, then serverOrigin should be used
      origin: this.imageOrigin ?? this.serverOrigin,
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
