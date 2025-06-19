import { Size, Stack } from "aws-cdk-lib";
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
import { PublicDirEntry } from "./nextjs-build/nextjs-build";

export interface NextjsApiOverrides {
  readonly restApiProps?: RestApiProps;
  readonly s3IntegrationProps?: AwsIntegrationProps;
  readonly s3MethodOptions?: MethodOptions;
  readonly lambdaIntegrationProps?: LambdaIntegrationOptions;
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
   * [Future] Required if `Nextjs*Containers`. VPC to create VPC Link and ECS Service Discovery
   */
  readonly vpc?: IVpc;
}

/**
 * Creates an API Gateway REST API for Next.js applications
 */
export class NextjsApi extends Construct {
  /**
   * The API Gateway REST API
   */
  public readonly api: RestApi;

  private readonly baseResource: IResource;
  private readonly props: NextjsApiProps;
  private staticIntegrationRole: IRole;

  constructor(scope: Construct, id: string, props: NextjsApiProps) {
    super(scope, id);
    this.props = props;

    this.validateProps(props);
    this.api = this.createRestApi();
    this.baseResource = this.createBaseResource(props.basePath);
    this.staticIntegrationRole = this.createStaticIntegrationRole();
    this.createStaticIntegrations();
    if (props.serverFunction) {
      this.createDynamicIntegration(props.serverFunction);
    } else {
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
      minCompressionSize: Size.bytes(0), // compress all responses for better perf
      ...this.props.overrides?.restApiProps,
    });
  }

  /**
   * Create base resource path if needed. Important if `basePath` is set.
   */
  private createBaseResource(basePath?: string): IResource {
    // Create base resource path if needed
    let baseResource = this.api.root;
    if (basePath) {
      const _basePath = basePath.startsWith("/")
        ? basePath.substring(1)
        : basePath;

      baseResource = this.api.root.addResource(_basePath);
    }
    return baseResource;
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
    // Add static assets route (_next/static/*)
    this.baseResource
      .addResource("_next")
      .addResource("static")
      .addResource("{proxy+}")
      .addMethod(
        "GET",
        this.createS3Integration({ key: "_next/static/{key}" }),
        this.getStaticMethodOptions({ proxy: true }),
      );
    // add public directory files/directories that exist at top level but need to go to S3.
    for (const publicDirEntry of this.props.publicDirEntries) {
      if (publicDirEntry.isDirectory) {
        this.baseResource
          .addResource(publicDirEntry.name)
          .addResource("{proxy+}")
          .addMethod(
            "GET",
            this.createS3Integration({ key: `${publicDirEntry.name}/{key}` }),
            this.getStaticMethodOptions({ proxy: true }),
          );
      } else {
        this.baseResource
          .addResource(publicDirEntry.name)
          .addMethod(
            "GET",
            this.createS3Integration({ key: publicDirEntry.name }),
            this.getStaticMethodOptions(),
          );
      }
    }
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
        requestParameters: key.includes("{key}")
          ? {
              "integration.request.path.key": "method.request.path.proxy",
            }
          : undefined,
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
            },
          },
          {
            statusCode: "404",
            selectionPattern: "404",
          },
        ],
      },
      ...this.props.overrides?.s3IntegrationProps,
    });
    return s3Integration;
  }

  private getStaticMethodOptions({ proxy } = { proxy: false }): MethodOptions {
    return {
      requestParameters: proxy
        ? {
            "method.request.path.proxy": true,
          }
        : undefined,
      methodResponses: [
        {
          statusCode: "200",
          responseParameters: {
            "method.response.header.Content-Type": true,
            "method.response.header.Content-Length": true,
            "method.response.header.Cache-Control": true,
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
   * Create Lambda Proxy integration for all other routes
   */
  private createDynamicIntegration(serverFunction: IFunction) {
    const lambdaIntegration = new LambdaIntegration(serverFunction, {
      ...this.props.overrides?.lambdaIntegrationProps,
    });
    // Add catch-all route for server-side rendering
    this.baseResource.addMethod("ANY", lambdaIntegration);
    const proxyResource = this.baseResource.addResource("{proxy+}");
    proxyResource.addMethod("ANY", lambdaIntegration);
  }
}
