import { copyFileSync, existsSync } from "node:fs";
import { join as joinPath } from "node:path";
import { Duration } from "aws-cdk-lib";
import { GatewayVpcEndpointAwsService } from "aws-cdk-lib/aws-ec2";
import { DockerImageAsset } from "aws-cdk-lib/aws-ecr-assets";
import {
  AwsLogDriverMode,
  Cluster,
  ContainerImage,
  ContainerInsights,
  CpuArchitecture,
  HealthCheck,
  LogDrivers,
} from "aws-cdk-lib/aws-ecs";
import {
  ApplicationLoadBalancedFargateService,
  ApplicationLoadBalancedFargateServiceProps,
} from "aws-cdk-lib/aws-ecs-patterns";
import { ApplicationProtocolVersion } from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { Construct } from "constructs";
import { NextjsComputeBaseProps } from "./nextjs-compute-base-props";
import { LOG_PREFIX, NextjsType } from "../constants";
import { OptionalApplicationLoadBalancedTaskImageOptions } from "../generated-structs/OptionalApplicationLoadBalancedTaskImageOptions";
import { OptionalClusterProps } from "../generated-structs/OptionalClusterProps";
import { OptionalDockerImageAssetProps } from "../generated-structs/OptionalDockerImageAssetProps";

export interface NextjsContainersOverrides {
  readonly ecsClusterProps?: OptionalClusterProps;
  readonly albFargateServiceProps?: ApplicationLoadBalancedFargateServiceProps;
  readonly taskImageOptions?: OptionalApplicationLoadBalancedTaskImageOptions;
  readonly dockerImageAssetProps?: OptionalDockerImageAssetProps;
}

export interface NextjsContainersProps extends NextjsComputeBaseProps {
  readonly overrides?: NextjsContainersOverrides;
  readonly relativeEntrypointPath: string;
}

/**
 * Next.js load balanced via Application Load Balancer with containers via AWS
 * Fargate.
 */
export class NextjsContainers extends Construct {
  albFargateService: ApplicationLoadBalancedFargateService;
  ecsCluster: Cluster;
  url: string;
  dockerImageAsset: DockerImageAsset;

  private props: NextjsContainersProps;

  constructor(scope: Construct, id: string, props: NextjsContainersProps) {
    super(scope, id);
    this.props = props;

    // Always create Docker image asset from local build output
    this.dockerImageAsset = this.createDockerImageAsset();
    this.ecsCluster = this.createEcsCluster();
    if (!props.overrides?.ecsClusterProps?.vpc) {
      this.addVpcGatewayEndpoints();
    }
    this.albFargateService = this.createAlbFargateSevice();
    this.configureHealthCheck();
    this.url = this.getUrl();
  }

  private createEcsCluster(): Cluster {
    return new Cluster(this, "EcsCluster", {
      enableFargateCapacityProviders: true,
      containerInsightsV2: ContainerInsights.ENABLED,
      ...this.props.overrides?.ecsClusterProps,
    });
  }

  /**
   * Add Gateway VPC endpoints for S3 and DynamoDB if user didn't provide a VPC.
   * Gateway endpoints are free and improve performance by keeping traffic within AWS network.
   */
  private addVpcGatewayEndpoints(): void {
    this.ecsCluster.vpc.addGatewayEndpoint("S3GatewayEndpoint", {
      service: GatewayVpcEndpointAwsService.S3,
    });
    this.ecsCluster.vpc.addGatewayEndpoint("DynamoDbGatewayEndpoint", {
      service: GatewayVpcEndpointAwsService.DYNAMODB,
    });
  }

  private createDockerImageAsset(): DockerImageAsset {
    // Build context is the buildDirectory (where the Next.js app is located)
    const buildContext = this.props.buildDirectory;
    const dockerfileName = this.getDockerfileName();

    this.copyDockerfileToContext(buildContext, dockerfileName);

    return new DockerImageAsset(this, "DockerImageAsset", {
      directory: buildContext,
      file: dockerfileName,
      buildArgs: {
        RELATIVE_PATH_TO_PACKAGE: this.props.relativePathToPackage || ".",
      },
      ...this.props.overrides?.dockerImageAssetProps,
    });
  }

  private getDockerfileName(): string {
    // Use the appropriate Dockerfile based on deployment type
    return this.props.nextjsType === NextjsType.GLOBAL_CONTAINERS
      ? "global-containers.Dockerfile"
      : "regional-containers.Dockerfile";
  }

  private copyDockerfileToContext(
    buildContext: string,
    dockerfileName: string,
  ): void {
    const targetDockerfile = joinPath(buildContext, dockerfileName);

    // Check if Dockerfile already exists - if so, use the existing one (developer control)
    if (existsSync(targetDockerfile)) {
      console.log(`${LOG_PREFIX} Using existing Dockerfile: ${dockerfileName}`);
    } else {
      const sourceDockerfile = joinPath(
        __dirname,
        "..",
        "nextjs-build",
        dockerfileName,
      );

      if (!existsSync(sourceDockerfile)) {
        throw new Error(
          `Source Dockerfile not found: ${sourceDockerfile}. Ensure the cdk-nextjs package is properly built.`,
        );
      }

      copyFileSync(sourceDockerfile, targetDockerfile);
      console.log(`${LOG_PREFIX} Created ${targetDockerfile}.`);
    }
  }

  private createAlbFargateSevice(): ApplicationLoadBalancedFargateService {
    let cpuArchitecture: CpuArchitecture | undefined = undefined;
    if (process.arch === "x64") {
      cpuArchitecture = CpuArchitecture.X86_64;
    } else if (process.arch === "arm64") {
      cpuArchitecture = CpuArchitecture.ARM64;
    }
    const albFargateService = new ApplicationLoadBalancedFargateService(
      this,
      "AlbFargateService",
      {
        circuitBreaker: { rollback: true, enable: true },
        cluster: this.ecsCluster,
        cpu: 1024,
        healthCheckGracePeriod: Duration.seconds(10),
        maxHealthyPercent: 200,
        memoryLimitMiB: 2048,
        minHealthyPercent: 100, // maintain service availability during deployment
        /*
          This protocol version is for the target group (Fargate), not the ALB
          Listener. From docs, "Application Load Balancers provide native support
          for HTTP/2 with HTTPS listeners". See https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html
          Next.js default server does not support HTTP/2 as it's recommended
          to proxy your Next.js server which we're doing with ALB.
          Also note, CloudFront only supports HTTP/1.1 origins.
          https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html#RequestCustomHTTPVersion
        */
        protocolVersion: ApplicationProtocolVersion.HTTP1,
        // if NextjsType.GLOBAL_CONTAINERS then we use VPC Origin Access which allows putting ALB in private subnet
        publicLoadBalancer:
          this.props.nextjsType === NextjsType.REGIONAL_CONTAINERS,
        runtimePlatform: {
          cpuArchitecture,
        },
        taskImageOptions: {
          command: ["node", this.props.relativeEntrypointPath],
          containerName: "nextjs",
          containerPort: 3000,
          image: ContainerImage.fromDockerImageAsset(this.dockerImageAsset),
          logDriver: LogDrivers.awsLogs({
            streamPrefix: "nextjs",
            mode: AwsLogDriverMode.NON_BLOCKING,
          }),
          ...this.props.overrides?.taskImageOptions,
          environment: {
            // Cache configuration environment variables
            CDK_NEXTJS_CACHE_BUCKET_NAME: this.props.cacheBucket.bucketName,
            CDK_NEXTJS_REVALIDATION_TABLE_NAME:
              this.props.revalidationTable.tableName,
            CDK_NEXTJS_BUILD_ID: this.props.buildId,
            // Merge with user-provided environment variables (user values take precedence)
            ...this.props.overrides?.taskImageOptions?.environment,
          },
        },
        ...this.props.overrides?.albFargateServiceProps,
      },
    );
    // required or health checks fail
    albFargateService.taskDefinition.defaultContainer?.addEnvironment(
      "HOSTNAME",
      "0.0.0.0",
    );

    // Grant cache access permissions
    this.props.cacheBucket.grantReadWrite(
      albFargateService.taskDefinition.taskRole,
    );
    this.props.revalidationTable.grantReadWriteData(
      albFargateService.taskDefinition.taskRole,
    );

    // speed up deployments by shortening deregistration delay
    // https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/load-balancer-connection-draining.html
    // TODO: document that this should be increased if long lived connections are expected
    albFargateService.targetGroup.setAttribute(
      "deregistration_delay.timeout_seconds",
      "30",
    );
    // best practice to enable cross zone load balancing
    // @see https://docs.aws.amazon.com/elasticloadbalancing/latest/application/disable-cross-zone.html
    albFargateService.loadBalancer.setAttribute(
      "load_balancing.cross_zone.enabled",
      "true",
    );
    return albFargateService;
  }
  /**
   * Configure health checks for containers at ALB and ECS level. This ensures
   * unhealthy containers are removed. Both of these health checks can be
   * overwritten by user by accessing `albFargateService` property, so no need
   * for `overrides`.
   */
  private configureHealthCheck() {
    // speed up deployments by shortening health checks
    // see https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/load-balancer-healthcheck.html
    this.albFargateService.targetGroup.configureHealthCheck({
      path: this.props.healthCheckPath,
      healthyThresholdCount: 2,
      interval: Duration.seconds(10), // too frequent? but enables faster rollback...
      timeout: Duration.seconds(5), // must be less than interval
    });
    const healthCheck: HealthCheck = {
      command: [
        "CMD-SHELL",
        // curl isn't available in alpine linux
        `wget --quiet --tries=1 --spider http://localhost:3000${this.props.healthCheckPath} || exit 1`,
      ],
    };
    const defaultContainer =
      this.albFargateService.taskDefinition.defaultContainer;
    if (defaultContainer) {
      // @ts-expect-error must use internal "props" attribute b/c no other way to add health check
      defaultContainer.props.healthCheck = healthCheck;
    }
  }
  private getUrl(): string {
    const protocol = this.albFargateService.certificate ? "https" : "http";
    return `${protocol}://${this.albFargateService.loadBalancer.loadBalancerDnsName}`;
  }
}
