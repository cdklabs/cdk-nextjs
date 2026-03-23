import { RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { AttributeType, Billing, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import {
  GatewayVpcEndpointAwsService,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { Cluster, ContainerInsights } from "aws-cdk-lib/aws-ecs";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ListenerAction,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

/**
 * SSM parameter name prefix used by both stacks.
 */
export const SSM_PREFIX = "/cdk-nextjs/bring-your-own";

/**
 * Shared infrastructure that is deployed once and reused by every branch stack.
 *
 * Exports resource identifiers via SSM Parameter Store so branch stacks can
 * import them without cross-stack references or CfnOutputs.
 */
export class SharedInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- VPC ---
    const vpc = new Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: "Public", subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "Private",
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });
    vpc.addGatewayEndpoint("S3Endpoint", {
      service: GatewayVpcEndpointAwsService.S3,
    });
    vpc.addGatewayEndpoint("DynamoEndpoint", {
      service: GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // --- ECS Cluster ---
    const cluster = new Cluster(this, "EcsCluster", {
      vpc,
      enableFargateCapacityProviders: true,
      containerInsightsV2: ContainerInsights.ENABLED,
    });

    // --- ALB ---
    const alb = new ApplicationLoadBalancer(this, "Alb", {
      vpc,
      internetFacing: true,
    });

    const listener = alb.addListener("HttpListener", {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      defaultAction: ListenerAction.fixedResponse(404, {
        contentType: "text/plain",
        messageBody:
          "No branch matched. Set a Host header that maps to a deployed branch.",
      }),
    });

    // --- S3: Cache Bucket ---
    const cacheBucket = new Bucket(this, "CacheBucket", {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- S3: Static Assets Bucket ---
    const staticAssetsBucket = new Bucket(this, "StaticAssetsBucket", {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // --- DynamoDB: Revalidation Table ---
    const revalidationTable = new TableV2(this, "RevalidationTable", {
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billing: Billing.onDemand(),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- SSM Parameters ---
    const params: Record<string, string> = {
      VpcId: vpc.vpcId,
      ClusterName: cluster.clusterName,
      AlbArn: alb.loadBalancerArn,
      ListenerArn: listener.listenerArn,
      CacheBucketName: cacheBucket.bucketName,
      StaticAssetsBucketName: staticAssetsBucket.bucketName,
      RevalidationTableName: revalidationTable.tableName,
    };

    for (const [key, value] of Object.entries(params)) {
      new StringParameter(this, `Param${key}`, {
        parameterName: `${SSM_PREFIX}/${key}`,
        stringValue: value,
      });
    }
  }
}
