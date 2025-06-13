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
} from "aws-cdk-lib/aws-apigateway";
import { IVpc } from "aws-cdk-lib/aws-ec2";
import { Role, ServicePrincipal, PolicyStatement } from "aws-cdk-lib/aws-iam";
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

  constructor(scope: Construct, id: string, props: NextjsApiProps) {
    super(scope, id);
    this.props = props;

    this.validateProps(props);
    this.api = this.createRestApi();
    this.baseResource = this.createBaseResource(props.basePath);
    this.createS3Integration();
    if (props.serverFunction) {
      this.createLambdaIntegration(props.serverFunction);
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

  /**
   * Create S3 integration for static assets
   */
  private createS3Integration() {
    // Create S3 integration role
    const s3IntegrationRole = new Role(this, "S3IntegrationRole", {
      assumedBy: new ServicePrincipal("apigateway.amazonaws.com"),
    });

    s3IntegrationRole.addToPolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`${this.props.staticAssetsBucket.bucketArn}/*`],
      }),
    );
    // Create S3 integration for static assets
    const s3Integration = new AwsIntegration({
      service: "s3",
      integrationHttpMethod: "GET",
      path: `${this.props.staticAssetsBucket.bucketName}/{key}`,
      options: {
        credentialsRole: s3IntegrationRole,
        requestParameters: {
          "integration.request.path.key": "method.request.path.proxy",
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
    // Create method options for static assets
    const staticMethodOptions: MethodOptions = {
      requestParameters: {
        "method.request.path.proxy": true,
      },
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

    // Add static assets route (_next/static/*)
    this.baseResource
      .addResource("_next")
      .addResource("static")
      .addResource("{proxy+}")
      .addMethod("GET", s3Integration, staticMethodOptions);
    // add public directory files/directories that exist at top level but need to go to S3.
    for (const publicDirEntry of this.props.publicDirEntries) {
      let publicDirResource: IResource;
      if (publicDirEntry.isDirectory) {
        publicDirResource = this.baseResource
          .addResource(publicDirEntry.name)
          .addResource("{proxy+}");
      } else {
        publicDirResource = this.baseResource.addResource(publicDirEntry.name);
      }
      publicDirResource.addMethod("GET", s3Integration, staticMethodOptions);
    }
  }

  /**
   * Create Lambda Proxy integration for all other routes
   */
  private createLambdaIntegration(serverFunction: IFunction) {
    const lambdaIntegration = new LambdaIntegration(serverFunction, {
      ...this.props.overrides?.lambdaIntegrationProps,
    });
    // Add catch-all route for server-side rendering
    const proxyResource = this.baseResource.addResource("{proxy+}");
    proxyResource.addMethod("ANY", lambdaIntegration);
  }
}
