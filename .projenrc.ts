import { join } from "node:path";
import { ProjenStruct, Struct } from "@mrgrain/jsii-struct-builder";
import { awscdk, javascript } from "projen";
import { JobStep } from "projen/lib/github/workflows-model";
import { UpgradeDependenciesSchedule } from "projen/lib/javascript";

const project = new awscdk.AwsCdkConstructLibrary({
  // repository config
  author: "Ben Stickley",
  authorAddress: "bestickley@gmail.com",
  defaultReleaseBranch: "main",
  repositoryUrl: "https://github.com/cdklabs/cdk-nextjs.git",
  depsUpgradeOptions: {
    workflowOptions: {
      schedule: UpgradeDependenciesSchedule.MONTHLY,
    },
  },
  // package.json config
  name: "cdk-nextjs",
  description:
    "Deploy Next.js apps on AWS with CDK" /* The description is just a string that helps people understand the purpose of the package. */,
  // majorVersion: 1,
  // prerelease: "beta",
  minNodeVersion: "20.0.0",
  keywords: ["nextjs", "next", "next.js", "aws-cdk", "aws", "cdk"],
  cdkVersion: "2.161.1",
  jsiiVersion: "~5.5.0",
  packageManager: javascript.NodePackageManager.PNPM,
  pnpmVersion: "9",
  projenVersion: "^0.88.0",
  devDeps: [
    "@aws-crypto/sha256-js",
    "@aws-sdk/client-sqs",
    "@aws-sdk/client-s3",
    "@mrgrain/jsii-struct-builder",
    "@smithy/signature-v4",
    "@types/aws-lambda",
    "@types/mime-types",
    "@types/node@^20",
    "cdk-nag",
    "esbuild",
    "mime-types",
    "next", // bundled in src/nextjs-build/cache-handler.ts
    "undici",
  ],
  npmIgnoreOptions: {
    ignorePatterns: ["examples/**/*"],
  },
  // tooling config
  lambdaOptions: {
    runtime: awscdk.LambdaRuntime.NODEJS_20_X,
  },
  projenCommand: "pnpm dlx projen",
  gitignore: [
    ".idea",
    ".DS_Store",
    "cdk.out",
    ".envrc",
    "*.drawio.bkp",
    "ash_output",
    "examples/.dockerignore",
    "examples/builder.Dockerfile",
  ],
  projenrcTs: true,
  eslintOptions: {
    prettier: true,
    dirs: ["src"],
    ignorePatterns: ["generated-structs/", "**/*-function.ts", "examples/"],
  },
  sampleCode: false,
});

// by default projen ignores all tsconfigs, but we don't want do this for non-projen
// managed repo.
project.gitignore.addPatterns("!/examples/**/tsconfig.json"); // must call method, cannot set in initial props
copyDockerfiles();
bundleFunctions();
updateGitHubWorkflows();
generateStructs();

project.synth();

function bundleFunctions() {
  const target = "node20";
  project.bundler.addBundle("src/nextjs-build/cache-handler.ts", {
    platform: "node",
    target,
    outfile: "../../../lib/nextjs-build/cache-handler.cjs",
  });
  project.bundler.addBundle("src/nextjs-build/add-cache-handler.ts", {
    platform: "node",
    target,
    outfile: "../../../lib/nextjs-build/add-cache-handler.mjs",
    format: "esm",
  });
  project.bundler.addBundle("src/nextjs-build/symlink-full-route-cache.ts", {
    platform: "node",
    target,
    outfile: "../../../lib/nextjs-build/symlink-full-route-cache.mjs",
    format: "esm",
  });
}

function copyDockerfiles() {
  const bundleTask = project.tasks.tryFind("bundle");
  if (bundleTask) {
    bundleTask.exec(`mkdir -p ${join("lib", "nextjs-build")}`);
    bundleTask.exec(
      `cp ${join("src", "nextjs-build", "assets-deployment.Dockerfile")} ${join("assets", "lambdas", "assets-deployment", "assets-deployment.lambda")}`,
    );
    bundleTask.exec(
      `cp ${join("src", "nextjs-build", "builder.Dockerfile")} ${join("lib", "nextjs-build")}`,
    );
    bundleTask.exec(
      `cp ${join("src", "nextjs-build", "global-containers.Dockerfile")} ${join("lib", "nextjs-build")}`,
    );
    bundleTask.exec(
      `cp ${join("src", "nextjs-build", "global-functions.Dockerfile")} ${join("lib", "nextjs-build")}`,
    );
    bundleTask.exec(
      `cp ${join("src", "nextjs-build", "regional-containers.Dockerfile")} ${join("lib", "nextjs-build")}`,
    );
  }
}

/**
 * @mrgrain/jsii-struct-builder is also used to generate optional structs of code
 * within this repository (OptionalNextjsBucketDeploymentProps, etc.). In order
 * for @mrgrain/jsii-struct-builder to read the source code struct to create a
 * generate struct with optional properties, the JSII assembly must exist. If
 * you simply run projen build this would fail because the JSII assembly of the
 * source code hasn't been created yet. We can get around this issue by running
 * projen compile first to create the JSII assembly, then projen build to use
 * @mrgrain/jsii-struct-builder to create the optional version of the struct.
 * The .projenrc.ts patches the build GitHub Workflow and Job to compile then
 * build. See more here.
 */
function updateGitHubWorkflows() {
  // .github/workflows/build.yml
  const buildWorkflow = project.github?.tryFindWorkflow("build");
  if (!buildWorkflow) return;
  const buildJob = buildWorkflow.getJob("build");
  if (!buildJob || !("steps" in buildJob)) return;
  // TODO: figure out why wrong types
  const getBuildSteps = buildJob.steps as unknown as () => JobStep[];
  const buildJobSteps = getBuildSteps();
  buildWorkflow.updateJob("build", {
    ...buildJob,
    steps: [
      ...buildJobSteps.slice(0, 4),
      {
        name: "Compile JSII",
        run: `pnpm projen compile`,
      },
      ...buildJobSteps.slice(4),
    ],
  });
}

/**
 * When you want to reuse interfaces/structs from the AWS CDK library and
 * customize them so all of their properties are optional, you cannot simply use
 * the TypeScript utility type, [Partial](https://www.typescriptlang.org/docs/handbook/utility-types.html#partialtype),
 * because of the TypeScript [limitations](https://aws.github.io/jsii/user-guides/lib-author/typescript-restrictions/#typescript-mapped-types)
 * of JSII. To solve this problem, this construct library uses
 * [@mrgrain/jsii-struct-builder](https://github.com/mrgrain/jsii-struct-builder)
 * to generate partial types. These types are defined in the .projenrc.ts files
 * (you'll need to scroll down to see them) and are primarily used in
 * NextjsOverrides. They files are in the src/generated-structs folder.
 *
 * Note, sometimes you might need to delete .jsii file to reset
 */
function generateStructs() {
  const getFilePath = (fileName: string) =>
    "src/generated-structs/" + fileName + ".ts";
  new ProjenStruct(project, {
    name: "OptionalS3OriginBucketWithOACProps",
    filePath: getFilePath("OptionalS3OriginBucketWithOACProps"),
  })
    .mixin(
      Struct.fromFqn(
        "aws-cdk-lib.aws_cloudfront_origins.S3BucketOriginWithOACProps",
      ),
    )
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalEdgeFunctionProps",
    filePath: getFilePath("OptionalEdgeFunctionProps"),
  })
    .mixin(
      Struct.fromFqn(
        "aws-cdk-lib.aws_cloudfront.experimental.EdgeFunctionProps",
      ),
    )
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalCloudFrontFunctionProps",
    filePath: getFilePath("OptionalCloudFrontFunctionProps"),
  })
    .mixin(Struct.fromFqn("aws-cdk-lib.aws_cloudfront.FunctionProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalDistributionProps",
    filePath: getFilePath("OptionalDistributionProps"),
  })
    .mixin(Struct.fromFqn("aws-cdk-lib.aws_cloudfront.DistributionProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalClusterProps",
    filePath: getFilePath("OptionalClusterProps"),
  })
    .mixin(Struct.fromFqn("aws-cdk-lib.aws_ecs.ClusterProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalDockerImageAssetProps",
    filePath: getFilePath("OptionalDockerImageAssetProps"),
  })
    .mixin(Struct.fromFqn("aws-cdk-lib.aws_ecr_assets.DockerImageAssetProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalNextjsBuildProps",
    filePath: getFilePath("OptionalNextjsBuildProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsBuildProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalNextjsDistributionProps",
    filePath: getFilePath("OptionalNextjsDistributionProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsDistributionProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalNextjsVpcProps",
    filePath: getFilePath("OptionalNextjsVpcProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsVpcProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalNextjsFileSystemProps",
    filePath: getFilePath("OptionalNextjsFileSystemProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsFileSystemProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalNextjsAssetsDeploymentProps",
    filePath: getFilePath("OptionalNextjsAssetsDeploymentProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsAssetsDeploymentProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalNextjsContainersProps",
    filePath: getFilePath("OptionalNextjsContainersProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsContainersProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalNextjsInvalidationProps",
    filePath: getFilePath("OptionalNextjsInvalidationProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsInvalidationProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalApplicationLoadBalancedTaskImageOptions",
    filePath: getFilePath("OptionalApplicationLoadBalancedTaskImageOptions"),
  })
    .mixin(
      Struct.fromFqn(
        "aws-cdk-lib.aws_ecs_patterns.ApplicationLoadBalancedTaskImageOptions",
      ),
    )
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalVpcProps",
    filePath: getFilePath("OptionalVpcProps"),
  })
    .mixin(Struct.fromFqn("aws-cdk-lib.aws_ec2.VpcProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalFunctionProps",
    filePath: getFilePath("OptionalFunctionProps"),
  })
    .mixin(Struct.fromFqn("aws-cdk-lib.aws_lambda.FunctionProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalFunctionUrlProps",
    filePath: getFilePath("OptionalFunctionUrlProps"),
  })
    .mixin(Struct.fromFqn("aws-cdk-lib.aws_lambda.FunctionUrlProps"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalDockerImageFunctionProps",
    filePath: getFilePath("OptionalDockerImageFunctionProps"),
  })
    .mixin(Struct.fromFqn("aws-cdk-lib.aws_lambda.DockerImageFunctionProps"))
    .allOptional();
}
