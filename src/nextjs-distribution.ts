import {
  ArnFormat,
  Aws,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
} from "aws-cdk-lib";
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
  CfnDistribution,
  CfnOriginAccessControl,
  Function as CloudFrontFunction,
  Distribution,
  FunctionAssociation,
  FunctionCode,
  FunctionEventType,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
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
  HttpOrigin,
  HttpOriginProps,
  S3Origin,
} from "aws-cdk-lib/aws-cloudfront-origins";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnBucketPolicy, IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { NextjsType } from "./common";
import { OptionalDistributionProps } from "./generated-structs/OptionalDistributionProps";
import { OptionalFunctionProps } from "./generated-structs/OptionalFunctionProps";
import { OptionalS3OriginProps } from "./generated-structs/OptionalS3OriginProps";
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
  readonly dynamicHttpOriginProps?: HttpOriginProps;
  readonly staticBehaviorOptions?: AddBehaviorOptions;
  readonly staticResponseHeadersPolicyProps?: ResponseHeadersPolicyProps;
  readonly s3OriginProps?: OptionalS3OriginProps;
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
   * Dynamic (Next.js server) URL to add behavior to distribution
   */
  readonly dynamicUrl: string;
  /**
   * Required if `NextjsType.GLOBAL_FUNCTIONS`
   */
  readonly functionArn?: string;
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
  private staticOrigin: S3Origin;
  private dynamicOrigin: HttpOrigin;
  private dynamicOriginResponsePolicy: IOriginRequestPolicy;
  private dynamicCloudFrontFunctionAssociations: FunctionAssociation[];
  private edgeLambdas?: AddBehaviorOptions["edgeLambdas"];
  private isFunctionCompute: boolean;
  private staticBehaviorOptions: BehaviorOptions;
  private dynamicBehaviorOptions: BehaviorOptions;
  private imageBehaviorOptions: BehaviorOptions;
  /**
   * Given stack id: "arn:aws:cloudformation:us-east-1:905418358903:stack/lh-stickb-idp/4bf74be0-e880-11ee-aea9-0affc6185b25",
   * returns "4bf74be0"
   */
  private uniqueStackIdPart = Fn.select(
    0,
    Fn.split("-", Fn.select(2, Fn.split("/", `${Aws.STACK_ID}`))),
  );

  constructor(scope: Construct, id: string, props: NextjsDistributionProps) {
    super(scope, id);
    this.props = props;
    this.staticOrigin = this.createStaticOrigin();
    this.isFunctionCompute = props.nextjsType === NextjsType.GLOBAL_FUNCTIONS;
    this.dynamicOrigin = this.createDynamicOrigin();
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
    this.addS3OacAndRemoveOai();
    if (this.isFunctionCompute) {
      // this.addLambdaOac(); // TODO: wait for POST body encryption feature for Lambda OAC
    }
    new CfnOutput(this, "DistributionDomainName", {
      value: this.distribution.domainName,
    });
  }

  private createStaticOrigin(): S3Origin {
    const s3Origin = new S3Origin(
      this.props.assetsBucket,
      this.props.overrides?.s3OriginProps,
    );
    return s3Origin;
  }
  private createDynamicOrigin(): HttpOrigin {
    let protocolPolicy: OriginProtocolPolicy;
    if (this.isFunctionCompute) {
      protocolPolicy = OriginProtocolPolicy.HTTPS_ONLY;
    } else {
      protocolPolicy = this.props.certificate
        ? OriginProtocolPolicy.HTTPS_ONLY
        : OriginProtocolPolicy.HTTP_ONLY;
    }
    return new HttpOrigin(Fn.parseDomainName(this.props.dynamicUrl), {
      protocolPolicy,
      ...this.props.overrides?.dynamicHttpOriginProps,
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
  /**
   * Required to sign requests so that we can use IAM_AUTH for Lambda Function URL
   * to prevent public access. Once CloudFront Lambda OAC is released, we can
   * use infra configuration for this instead of custom code.
   */
  private createEdgeLambdas(): AddBehaviorOptions["edgeLambdas"] {
    if (!this.props.functionArn) throw new Error("functionArn is required");
    const edgeFn = new SignFnUrlFunction(this, "SignFnUrl", {
      currentVersionOptions: {
        retryAttempts: 0, // fail fast when trying to delete b/c replicated functions take long time to delete
      },
      initialPolicy: [
        new PolicyStatement({
          actions: ["lambda:InvokeFunctionUrl"],
          resources: [this.props.functionArn],
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
      edgeLambdas: this.edgeLambdas,
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
        httpVersion: HttpVersion.HTTP2, // HTTP2_AND_3 causes timeout issues with Lambda Function URLs!
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
  /**
   * Add Origin Access Control (OAC) to CloudFront Distribution which is preferred
   * way to secure access from Distribution to S3. Remove legacy OAI.
   *
   * When CDK releases L2 support for this, please remove this code.
   * @see https://github.com/aws/aws-cdk/issues/21771#issuecomment-1567647338
   */
  private addS3OacAndRemoveOai() {
    const s3Oac = new CfnOriginAccessControl(this, "OAC", {
      originAccessControlConfig: {
        name: `OAC-S3-${this.uniqueStackIdPart}`,
        originAccessControlOriginType: "s3",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      },
    });
    // add OAC to CloudFront Distribution
    const cfnDistribution = this.distribution.node
      .defaultChild as CfnDistribution;
    cfnDistribution.addOverride(
      "Properties.DistributionConfig.Origins.1.S3OriginConfig.OriginAccessIdentity",
      "",
    );
    cfnDistribution.addPropertyOverride(
      "DistributionConfig.Origins.1.OriginAccessControlId",
      s3Oac.getAtt("Id"),
    );

    // add IAM Policy Statement to allow OAC access to Bucket
    const oacBucketStatement = new PolicyStatement({
      sid: "AllowS3OacAccess",
      principals: [new ServicePrincipal("cloudfront.amazonaws.com")],
      actions: ["s3:GetObject"],
      resources: [this.props.assetsBucket.bucketArn + "/*"],
      conditions: {
        StringEquals: {
          "aws:sourceArn": Stack.of(this).formatArn({
            service: "cloudfront",
            region: "",
            resource: "distribution",
            resourceName: this.distribution.distributionId,
            arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
          }),
        },
      },
    });
    this.props.assetsBucket.addToResourcePolicy(oacBucketStatement);
    // Remove OAI IAM Policy Statement from Bucket Policy
    const bucketPolicyJson = this.props.assetsBucket.policy?.document.toJSON();
    const updatedBucketPolicyJson = {
      Version: "2012-10-17",
      Statement: [] as unknown[],
    };
    for (const statement of bucketPolicyJson.Statement) {
      if (!("CanonicalUser" in statement.Principal)) {
        updatedBucketPolicyJson.Statement.push(statement);
      }
    }
    const bucketPolicy = this.props.assetsBucket.node.findChild("Policy").node
      .defaultChild as CfnBucketPolicy;
    bucketPolicy.addOverride(
      "Properties.PolicyDocument",
      updatedBucketPolicyJson,
    );

    // Remove S3 Origin Resource
    const distributionChildren = this.distribution.node.findAll();
    for (const child of distributionChildren) {
      if (child.node.id === "S3Origin") {
        child.node.tryRemoveChild("Resource");
      }
    }
  }

  // TODO: use when POST body encryption feature is added for Lambda OAC
  // private addLambdaOac() {
  //   const lambdaOac = new CfnOriginAccessControl(this, "OAC", {
  //     originAccessControlConfig: {
  //       name: `OAC-Lambda-${this.uniqueStackIdPart}`,
  //       originAccessControlOriginType: "lambda",
  //       signingBehavior: "always",
  //       signingProtocol: "sigv4",
  //     },
  //   });
  //   const cfnDistribution = this.distribution.node
  //     .defaultChild as CfnDistribution;
  //   cfnDistribution.addPropertyOverride(
  //     "DistributionConfig.Origins.0.OriginAccessControlId",
  //     lambdaOac.getAtt("Id"),
  //   );
  // }
}
