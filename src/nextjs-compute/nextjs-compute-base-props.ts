import { IVpc } from "aws-cdk-lib/aws-ec2";
import { AccessPoint } from "aws-cdk-lib/aws-efs";

export interface NextjsComputeBaseProps {
  readonly accessPoint: AccessPoint;
  readonly containerMountPathForEfs: string;
  readonly healthCheckPath: string;
  readonly vpc: IVpc;
}
