import {
  InterfaceVpcEndpointAwsService,
  IVpc,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";
import { NextjsType } from "./common";
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

  /**
   * cdk-nextjs requires a VPC because of the use of EFS. The Next.js containers
   * or functions can be placed in "private with egress" subnets or "private isolated"
   * subnets. "Private with egress" subnets allow for outbound traffic to the internet
   * but require a NAT Gateway which costs $65/month for 2 AZs. "Private isolated"
   * subnets do not require a NAT Gateway therefore they are used by default.
   * @see https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2-readme.html#subnet-types
   */
  private createVpc() {
    return new Vpc(this, "Vpc", {
      maxAzs: 2, // might want 3 in production
      subnetConfiguration: [
        { name: "Public", subnetType: SubnetType.PUBLIC },
        // PrivateWithEgress subnet uses NAT Gateway which costs $32/az/month
        {
          name: "PrivateWithEgress",
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
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
