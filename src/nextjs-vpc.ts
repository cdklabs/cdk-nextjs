import {
  InterfaceVpcEndpointAwsService,
  IVpc,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { NextjsType } from "./constants";
import { OptionalVpcProps } from "./generated-structs/OptionalVpcProps";

export interface NextjsVpcOverrides {
  readonly vpcProps?: OptionalVpcProps;
}

export interface NextjsVpcProps {
  readonly nextjsType: NextjsType;
  /**
   * Override any construct.
   */
  readonly overrides?: NextjsVpcOverrides;
  /**
   * Bring your own VPC.
   */
  readonly vpc?: IVpc;
}

/**
 * cdk-nextjs requires a VPC because of the use of EFS but if you're building on
 * AWS you probably already need one for other resources (i.e. RDS/Aurora).
 * You can provide your own VPC via `overrides.nextjsVpc.vpc` but you'll be
 * responsible for creating the VPC. All cdk-nextjs constructs require a
 * `SubnetType.PRIVATE_ISOLATED` subnet for EFS and `SubnetType.PRIVATE_WITH_EGRESS`
 * for compute. `NextjsRegionalContainers` requires a `SubnetType.PUBLIC`
 * subnet for CloudFront to reach the ALB. `NextjsGlobalFunctions` and
 * `NextjsGlobalContainers` don't require a `SubnetType.PUBLIC` subnet because
 * CloudFront accesses their compute securely through Function URL and VPC
 * Origin Access.
 *
 * Note, if you use `NextjsVpc` then the default CDK VPC will be created
 * for you with 2 AZs of all 3 types of subnets with a NAT Gateway in your
 * `SubnetType.PUBLIC` subnet to allow for secure internet access from your
 * `SubnetType.PRIVATE_WITH_EGRESS` subnet. This is recommended by AWS, but
 * it costs $65/month for 2 AZs. See examples/low-cost for alternative.
 *
 * @see https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2-readme.html#subnet-types
 */
export class NextjsVpc extends Construct {
  vpc: IVpc;

  private props: NextjsVpcProps;

  constructor(scope: Construct, id: string, props: NextjsVpcProps) {
    super(scope, id);
    this.props = props;
    if (props.vpc) {
      this.vpc = props.vpc;
    } else {
      this.vpc = props.vpc ?? this.createVpc();
      this.createVpcEndpoints();
    }
  }

  private createVpc() {
    return new Vpc(this, "Vpc", {
      maxAzs: 2, // might want 3 in production
      subnetConfiguration: [
        // NAT Gateway and ALB for NextjsRegionalContainers live in Public subnets
        { name: "Public", subnetType: SubnetType.PUBLIC },
        // All compute and ALB for NextjsGlobalContainers lives in PrivateWithEgress subnets
        {
          name: "PrivateWithEgress",
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        // EFS lives in PrivateIsolated subnets
        { name: "PrivateIsolated", subnetType: SubnetType.PRIVATE_ISOLATED },
      ],
      ...this.props.overrides?.vpcProps,
    });
  }

  /**
   * Best practice is to use VPC endpoints between VPC and serverless resources
   * so that traffic does not go over public internet.
   *
   * While gateway endpoints are free, interface endpoints (use PrivateLink)
   * cost ~$7/month/az.
   *
   * @see https://www.alexdebrie.com/posts/aws-lambda-vpc/#set-up-a-vpc-endpoint-for-your-aws-service
   */
  private createVpcEndpoints() {
    if (this.props.nextjsType === NextjsType.GLOBAL_FUNCTIONS) {
      this.vpc.addInterfaceEndpoint("SqsInterfaceEndpoint", {
        service: InterfaceVpcEndpointAwsService.SQS,
      });
    }
  }
}
