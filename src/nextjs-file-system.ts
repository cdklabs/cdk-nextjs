import { RemovalPolicy } from "aws-cdk-lib";
import { Connections, IVpc } from "aws-cdk-lib/aws-ec2";
import {
  AccessPoint,
  AccessPointProps,
  FileSystem,
  FileSystemProps,
  LifecyclePolicy,
} from "aws-cdk-lib/aws-efs";
import { IRole } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface NextjsFileSystemOverrides {
  readonly fileSystemProps?: FileSystemProps;
  readonly accessPointProps?: AccessPointProps;
}

export interface NextjsFileSystemProps {
  readonly overrides?: NextjsFileSystemOverrides;
  readonly vpc: IVpc;
}

export interface AllowComputeProps {
  readonly connections: Connections;
  readonly role: IRole;
}

/**
 * Next.js Network File System enabling sharing of image optimization cache,
 * data cach, and pages cache.
 */
export class NextjsFileSystem extends Construct {
  fileSystem: FileSystem;
  accessPoint: AccessPoint;
  private props: NextjsFileSystemProps;

  constructor(scope: Construct, id: string, props: NextjsFileSystemProps) {
    super(scope, id);
    this.props = props;
    this.fileSystem = this.createFileSystem();
    this.accessPoint = this.createAccessPoint();
  }
  /**
   * Creates EFS File System
   *
   * Note, the resource policy for the File System will include the boolean
   * condition, `"elasticfilesystem:AccessedViaMountTarget": "true"` which from
   * CDK [docs](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_efs-readme.html#permissions)
   * says, "only allow access to clients using IAM authentication and deny access
   * to anonymous clients".
   * @see https://docs.aws.amazon.com/efs/latest/ug/access-control-block-public-access.html
   *
   * Ideally we could add IAM string condition `elasticfilesystem:AccessPointArn`
   * to the resource policy but this causes circular dependency.
   */
  private createFileSystem() {
    const fileSystem = new FileSystem(this, "FileSystem", {
      encrypted: true,
      lifecyclePolicy: LifecyclePolicy.AFTER_30_DAYS,
      removalPolicy: RemovalPolicy.DESTROY,
      vpc: this.props.vpc,
      allowAnonymousAccess: false,
      ...this.props.overrides?.fileSystemProps,
    });
    return fileSystem;
  }
  private createAccessPoint() {
    const uid = "1001";
    const gid = "1001";
    const accessPoint = new AccessPoint(this, "AccessPoint", {
      // as /next/cache doesn't exist in a new efs filesystem, the efs will
      // create the directory with the following options
      createAcl: {
        ownerGid: gid,
        ownerUid: uid,
        permissions: "755",
      },
      fileSystem: this.fileSystem,
      path: "/next/cache",
      // enforce POSIX identity so container wil access file system with this identity
      posixUser: {
        gid,
        uid,
      },
      ...this.props.overrides?.accessPointProps,
    });
    return accessPoint;
  }
  allowCompute({ connections, role }: AllowComputeProps) {
    this.fileSystem.connections.allowDefaultPortFrom(connections);
    this.fileSystem.grantReadWrite(role);
  }
}
