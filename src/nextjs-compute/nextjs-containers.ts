import { copyFileSync, existsSync } from "node:fs";
import { join as joinPath } from "node:path";
import { CfnOutput, CfnResource, Duration, Stack } from "aws-cdk-lib";
import { GatewayVpcEndpointAwsService } from "aws-cdk-lib/aws-ec2";
import { DockerImageAsset } from "aws-cdk-lib/aws-ecr-assets";
import {
  AwsLogDriverMode,
  Cluster,
  ContainerImage,
  ContainerInsights,
  CpuArchitecture,
  HealthCheck,
  ICluster,
  LogDrivers,
} from "aws-cdk-lib/aws-ecs";
import {
  ApplicationLoadBalancedFargateService,
  ApplicationLoadBalancedFargateServiceProps,
} from "aws-cdk-lib/aws-ecs-patterns";
import {
  ApplicationProtocolVersion,
  IApplicationLoadBalancer,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import { CfnElement } from "aws-cdk-lib/core";
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
  /**
   * Bring your own Application Load Balancer. When provided, it is passed
   * directly to `ApplicationLoadBalancedFargateService`. If the ALB already
   * has a listener on port 80, call `removeAutoCreatedListener()` after
   * construction to avoid deployment failures.
   */
  readonly alb?: IApplicationLoadBalancer;
  /**
   * Bring your own ECS cluster. When provided, cdk-nextjs will skip creating
   * a new cluster and VPC gateway endpoints. The cluster is passed directly
   * to `ApplicationLoadBalancedFargateService`.
   */
  readonly ecsCluster?: ICluster;
  readonly overrides?: NextjsContainersOverrides;
  readonly relativeEntrypointPath: string;
}

/**
 * Next.js load balanced via Application Load Balancer with containers via AWS
 * Fargate.
 */
export class NextjsContainers extends Construct {
  albFargateService: ApplicationLoadBalancedFargateService;
  ecsCluster: ICluster;
  url: string;
  dockerImageAsset: DockerImageAsset;

  private props: NextjsContainersProps;

  constructor(scope: Construct, id: string, props: NextjsContainersProps) {
    super(scope, id);
    this.props = props;

    // Always create Docker image asset from local build output
    this.dockerImageAsset = this.createDockerImageAsset();
    if (props.ecsCluster) {
      this.ecsCluster = props.ecsCluster;
    } else {
      this.ecsCluster = this.createEcsCluster();
      if (!props.overrides?.ecsClusterProps?.vpc) {
        this.addVpcGatewayEndpoints();
      }
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
        ...this.props.overrides?.dockerImageAssetProps?.buildArgs,
      },
      exclude: ["cdk.out"], // for common case where cdk deploy is run in same directory as nextjs app
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
        ...(this.props.alb ? { loadBalancer: this.props.alb } : {}),
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
    // Only configure ALB attributes when we own the ALB.
    // If user provided their own, they're responsible for its configuration.
    if (
      !this.props.alb &&
      !this.props.overrides?.albFargateServiceProps?.loadBalancer
    ) {
      // best practice to enable cross zone load balancing
      // @see https://docs.aws.amazon.com/elasticloadbalancing/latest/application/disable-cross-zone.html
      albFargateService.loadBalancer.setAttribute(
        "load_balancing.cross_zone.enabled",
        "true",
      );
    }
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
    // we check top-level alb and overrides first b/c if using imported
    // loadBalancer then you cannot access `albFargateService.loadBalancer`,
    // you must access via passed in `loadBalancer` which
    // `ApplicationLoadBalancedFargateService` accepts as props
    const dnsName =
      this.props.alb?.loadBalancerDnsName ??
      this.props.overrides?.albFargateServiceProps?.loadBalancer
        ?.loadBalancerDnsName ??
      this.albFargateService.loadBalancer.loadBalancerDnsName;
    return `${protocol}://${dnsName}`;
  }

  /**
   * Remove the HTTP listener that `ApplicationLoadBalancedFargateService`
   * always creates. Call this when you bring your own ALB that already has a
   * listener on the same port (typically port 80) to avoid a
   * "listener already exists on this port" deployment failure.
   *
   * This method:
   * 1. Removes the L1 `CfnListener` resource (keeps the L2 node so the
   *    target group child is preserved).
   * 2. Removes the associated security-group ingress rule for port 80.
   * 3. Rebuilds the ECS service `DependsOn` without the deleted listener.
   * 4. Removes `CfnOutput` resources auto-created by the ecs-patterns construct.
   */
  removeAutoCreatedListener(): void {
    const listener = this.albFargateService.listener;
    const cfnListener = listener.node.defaultChild;
    if (!(cfnListener instanceof CfnResource)) return;

    // 1. Remove only the CfnListener L1 resource, not the L2 construct.
    //    The target group (a sibling child of the listener node) stays.
    listener.node.tryRemoveChild(cfnListener.node.id);

    // 2. Remove the SG ingress rule the listener auto-creates for port 80.
    const albSgNode = this.node
      .findAll()
      .find(
        (c) =>
          c instanceof CfnResource &&
          c.cfnResourceType === "AWS::EC2::SecurityGroupIngress" &&
          c.node.path.includes("from 0.0.0.0/0:80"),
      );
    if (albSgNode) {
      albSgNode.node.scope?.node.tryRemoveChild(albSgNode.node.id);
    }

    // 3. Rebuild the ECS service DependsOn without the deleted listener.
    //    CDK generates DependsOn during _toCloudFormation(). addOverride
    //    runs after that and replaces the generated value.
    const cfnService = this.albFargateService.service.node.defaultChild;
    const cfnTargetGroup = this.albFargateService.targetGroup.node.defaultChild;
    const taskDef = this.albFargateService.taskDefinition;
    const taskRole = taskDef.taskRole.node.defaultChild;
    const taskRolePolicy =
      taskDef.taskRole.node.tryFindChild("DefaultPolicy")?.node.defaultChild;

    if (cfnService instanceof CfnResource) {
      const stack = Stack.of(this);
      const keepDeps = [cfnTargetGroup, taskRole, taskRolePolicy]
        .filter((d): d is CfnElement => d instanceof CfnElement)
        .map((d) => stack.getLogicalId(d));

      // Also keep any listener rules (e.g. path-based routing rules)
      for (const child of stack.node.findAll()) {
        if (
          child instanceof CfnResource &&
          child.cfnResourceType === "AWS::ElasticLoadBalancingV2::ListenerRule"
        ) {
          keepDeps.push(stack.getLogicalId(child));
        }
      }
      cfnService.addOverride("DependsOn", keepDeps);
    }

    // 4. Remove CfnOutput resources auto-created by ApplicationLoadBalancedFargateService
    for (const child of this.node.findAll()) {
      if (child instanceof CfnOutput) {
        child.node.scope?.node.tryRemoveChild(child.node.id);
      }
    }
  }
}
