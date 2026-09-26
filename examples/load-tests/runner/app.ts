import {
  App,
  ArnFormat,
  CfnOutput,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import {
  BlockDeviceVolume,
  Instance,
  InstanceType,
  MachineImage,
  SecurityGroup,
  SubnetType,
  UserData,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import { ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import { join } from "node:path";

const K6_VERSION = "2.3.0";

/**
 * One EC2 instance to run the load tests from, in the same region as the
 * stacks under test, so published numbers carry neither a home connection's
 * bandwidth cap nor its jitter. No inbound ports: connect with SSM Session
 * Manager. The load-tests directory is copied onto it at /opt/load-tests, and
 * a changed copy replaces the instance. `-c count=N` makes N identical
 * instances, one per stack under test, so tests can run at once without
 * sharing a load generator.
 */
class LoadTestRunnerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    const instanceType = this.node.tryGetContext("instanceType") ?? "c7g.2xlarge";
    // e.g. `-c availabilityZone=us-east-1b` when the default zone is out of the instance type
    const availabilityZone: string | undefined = this.node.tryGetContext("availabilityZone");
    const count = Number(this.node.tryGetContext("count") ?? 1);

    const vpc = new Vpc(this, "Vpc", {
      ...(availabilityZone ? { availabilityZones: [availabilityZone] } : { maxAzs: 1 }),
      natGateways: 0,
      subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC }],
    });
    const securityGroup = new SecurityGroup(this, "SecurityGroup", {
      vpc,
      allowAllOutbound: true,
      description: "Load test runner: outbound only",
    });

    const results = new Bucket(this, "Results", {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const scripts = new Asset(this, "Scripts", {
      path: join(import.meta.dirname, ".."),
      exclude: ["node_modules", "results", "cdk.out", "runner-outputs.json", ".env"],
    });

    const role = new Role(this, "Role", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    scripts.grantRead(role);
    results.grantReadWrite(role);
    // `pnpm cold-start`, against the perf-* stacks only
    role.addToPolicy(
      new PolicyStatement({
        actions: ["cloudformation:ListStackResources"],
        resources: [this.formatArn({ service: "cloudformation", resource: "stack", resourceName: "perf-*" })],
      }),
    );
    role.addToPolicy(
      new PolicyStatement({
        // GetFunction: `aws lambda wait function-updated-v2` polls with it
        actions: ["lambda:GetFunction", "lambda:GetFunctionConfiguration", "lambda:UpdateFunctionConfiguration"],
        resources: [this.formatArn({ service: "lambda", resource: "function", resourceName: "perf-*", arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      }),
    );

    const userData = UserData.forLinux();
    userData.addCommands(
      "set -euxo pipefail",
      "snap install aws-cli --classic",
      // The k6 apt repo has no arm64 package; pin the release the laptop runs too
      `curl -fsSL https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-arm64.tar.gz | tar -xz --strip-components=1 -C /usr/local/bin k6-v${K6_VERSION}-linux-arm64/k6`,
      "apt-get update",
      "DEBIAN_FRONTEND=noninteractive apt-get install -y unzip",
      "snap install chromium",
      // for scripts/cold-start.ts and scripts/report.ts: node builtins only, and
      // Node 24 runs TypeScript itself
      "snap install node --classic --channel=24",
      // https://grafana.com/docs/k6/latest/testing-guides/running-large-tests/
      "printf 'net.ipv4.ip_local_port_range = 1024 65535\\nnet.ipv4.tcp_tw_reuse = 1\\nnet.ipv4.tcp_timestamps = 1\\n' > /etc/sysctl.d/99-k6.conf",
      "sysctl --system",
      "printf '* soft nofile 250000\\n* hard nofile 250000\\n' > /etc/security/limits.d/99-k6.conf",
    );
    // Not addS3DownloadCommand: a download that breaks off partway would fail
    // the whole user data script.
    const zip = "/tmp/load-tests.zip";
    userData.addCommands(
      `for attempt in 1 2 3 4 5; do aws s3 cp ${scripts.s3ObjectUrl} ${zip} && break; sleep 5; done`,
      `mkdir -p /opt/load-tests && unzip -o ${zip} -d /opt/load-tests`,
      "chmod -R a+rwX /opt/load-tests",
      `printf 'export RESULTS_BUCKET=${results.bucketName}\\nexport AWS_REGION=${this.region}\\nexport AWS_DEFAULT_REGION=${this.region}\\nexport K6_BROWSER_EXECUTABLE_PATH=/snap/bin/chromium\\n# Chromium refuses to run as root, which SSM commands run as, without it\\nexport K6_BROWSER_ARGS=no-sandbox\\n' > /etc/profile.d/load-tests.sh`,
    );

    const instanceIds: string[] = [];
    for (let i = 1; i <= count; i++) {
      const instance = new Instance(this, count === 1 ? "Instance" : `Instance${i}`, {
        vpc,
        vpcSubnets: { subnetType: SubnetType.PUBLIC },
        securityGroup,
        role,
        instanceType: new InstanceType(instanceType),
        machineImage: MachineImage.fromSsmParameter(
          "/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id",
        ),
        blockDevices: [{ deviceName: "/dev/sda1", volume: BlockDeviceVolume.ebs(30, { encrypted: true }) }],
        requireImdsv2: true,
        associatePublicIpAddress: true,
        userData,
        userDataCausesReplacement: true,
      });
      instanceIds.push(instance.instanceId);
    }

    new CfnOutput(this, "InstanceIds", { value: Fn.join(",", instanceIds) });
    new CfnOutput(this, "ResultsBucket", { value: results.bucketName });
    new CfnOutput(this, "Connect", {
      value: `aws ssm start-session --target <instance id> --document-name AWS-StartInteractiveCommand --parameters command="bash -l"`,
    });
  }
}

const app = new App();
new LoadTestRunnerStack(app, "perf-load-test-runner", {
  env: { account: process.env["CDK_DEFAULT_ACCOUNT"], region: process.env["CDK_DEFAULT_REGION"] },
});
