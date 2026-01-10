import { join } from "node:path/posix";
import { Duration } from "aws-cdk-lib";
import { IVpc } from "aws-cdk-lib/aws-ec2";
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
import {
  CACHE_PATH,
  DATA_CACHE_PATH,
  IMAGE_CACHE_PATH,
  NextjsType,
  PUBLIC_PATH,
} from "../constants";
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
  /**
   * VPC is required for container deployments.
   * Containers need VPC for networking.
   */
  readonly vpc: IVpc;
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
    this.albFargateService = this.createAlbFargateSevice();
    this.configureHealthCheck();
    this.url = this.getUrl();
  }

  private createEcsCluster(): Cluster {
    const cluster = new Cluster(this, "EcsCluster", {
      enableFargateCapacityProviders: true,
      containerInsightsV2: ContainerInsights.ENABLED,
      vpc: this.props.vpc, // VPC is required in interface
      ...this.props.overrides?.ecsClusterProps,
    });
    return cluster;
  }

  private createDockerImageAsset(): DockerImageAsset {
    const dockerfilePath = this.getDockerfilePath();
    const buildContext = this.getBuildContext();

    return new DockerImageAsset(this, "DockerImageAsset", {
      directory: buildContext,
      file: dockerfilePath,
      buildArgs: {
        RELATIVE_PATH_TO_PACKAGE: this.props.relativePathToPackage || ".",
        BUILD_ID: this.props.buildId,
        CACHE_PATH,
        DATA_CACHE_PATH,
        IMAGE_CACHE_PATH,
        PUBLIC_PATH,
      },
      ...this.props.overrides?.dockerImageAssetProps,
    });
  }

  private getDockerfilePath(): string {
    // Use the appropriate Dockerfile based on deployment type
    const dockerfileName =
      this.props.nextjsType === NextjsType.GLOBAL_CONTAINERS
        ? "global-containers.Dockerfile"
        : "regional-containers.Dockerfile";

    // Dockerfiles are located in lib/nextjs-build after build process
    // Path is relative to build context
    return `../lib/nextjs-build/${dockerfileName}`;
  }

  private getBuildContext(): string {
    if (!this.props.buildOutputPath) {
      throw new Error("buildOutputPath is required for local builds");
    }

    // Build context is the directory containing the .next folder
    // This allows the Dockerfile to access both .next output and lib/nextjs-build
    const packagePath = this.props.relativePathToPackage || ".";
    return join(this.props.buildOutputPath, packagePath);
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
          environment: {
            // Cache configuration environment variables
            CACHE_BUCKET_NAME: this.props.cacheBucket.bucketName,
            REVALIDATION_TABLE_NAME: this.props.revalidationTable.tableName,
            BUILD_ID: this.props.buildId,
          },
          ...this.props.overrides?.taskImageOptions,
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
