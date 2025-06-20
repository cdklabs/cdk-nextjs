import { join } from "node:path";
import { ProjenStruct, Struct } from "@mrgrain/jsii-struct-builder";
import { awscdk, javascript, JsonPatch, ReleasableCommits } from "projen";
import { LambdaRuntime } from "projen/lib/awscdk";
import { JobStep } from "projen/lib/github/workflows-model";
import { UpgradeDependenciesSchedule } from "projen/lib/javascript";

const nodeVersion = 22;
const project = new awscdk.AwsCdkConstructLibrary({
  // repository config
  author: "Ben Stickley",
  authorAddress: "bestickley@gmail.com",
  defaultReleaseBranch: "main",
  repositoryUrl: "https://github.com/cdklabs/cdk-nextjs.git",
  // package.json config
  name: "cdk-nextjs",
  description:
    "Deploy Next.js apps on AWS with CDK" /* The description is just a string that helps people understand the purpose of the package. */,
  // majorVersion: 1,
  // prerelease: "beta",
  keywords: ["nextjs", "next", "next.js", "aws-cdk", "aws", "cdk"],
  cdkVersion: "2.196.0",
  jsiiVersion: "~5.8.7",
  packageManager: javascript.NodePackageManager.PNPM,
  pnpmVersion: "9",
  projenVersion: "^0.90.6",
  devDeps: [
    "@aws-crypto/sha256-js",
    "@aws-sdk/client-cloudfront",
    "@aws-sdk/client-s3",
    "@aws-sdk/lib-storage",
    "@mrgrain/jsii-struct-builder",
    "@smithy/signature-v4",
    "@types/aws-lambda",
    "@types/mime-types",
    "@types/node@^20",
    "cdk-nag",
    "esbuild",
    "mime-types",
    "next@14", // bundled in src/nextjs-build/cache-handler.ts
    "undici",
  ],
  npmIgnoreOptions: {
    ignorePatterns: ["examples/**/*"],
  },
  // tooling config
  depsUpgradeOptions: {
    workflowOptions: {
      schedule: UpgradeDependenciesSchedule.WEEKLY,
    },
  },
  autoApproveUpgrades: true,
  autoApproveOptions: {
    allowedUsernames: [
      "cdklabs-automation",
      "github-bot",
      "github-actions[bot]",
    ],
  },
  lambdaOptions: {
    runtime: new LambdaRuntime(`nodejs${nodeVersion}.x`, `node${nodeVersion}`),
    awsSdkConnectionReuse: false, // doesn't exist in AWS SDK JS v3
  },
  projenCommand: "pnpm dlx projen",
  gitignore: [".idea", ".DS_Store", "*.drawio.bkp", "ash_output", "~$*.xlsx"],
  projenrcTs: true,
  eslintOptions: {
    prettier: true,
    dirs: ["src"],
    ignorePatterns: ["generated-structs/", "**/*-function.ts", "examples/"],
  },
  sampleCode: false,
  releasableCommits: ReleasableCommits.ofType([
    "feat",
    "fix",
    "chore",
    "refactor",
    "perf",
  ]),
  githubOptions: {
    mergifyOptions: {
      rules: [
        {
          name: "Automatically merge dependency updates",
          conditions: [
            "author=github-actions[bot]",
            "title~=^chore\\(deps\\): upgrade dependencies",
            "status-success=build",
            "status-success=package-js",
          ],
          actions: {
            merge: {
              method: "squash",
              strict: true,
              commit_message: "title+body",
            },
          },
        },
      ],
    },
    pullRequestLintOptions: {
      semanticTitleOptions: {
        types: [
          // see commit types here: https://www.conventionalcommits.org/en/v1.0.0/#summary
          "feat",
          "fix",
          "chore",
          "refactor",
          "perf",
          "docs",
          "style",
          "test",
          "build",
          "ci",
        ],
      },
    },
  },
  versionrcOptions: {
    types: [
      { type: "feat", section: "Features" },
      { type: "fix", section: "Bug Fixes" },
      { type: "chore", section: "Chores" },
      { type: "docs", section: "Docs" },
      { type: "style", hidden: true },
      { type: "refactor", hidden: true },
      { type: "perf", section: "Performance" },
      { type: "test", hidden: true },
    ],
  },
});

// by default projen ignores all tsconfigs, but we don't want do this for non-projen
// managed repo.
project.gitignore.addPatterns("!/examples/**/tsconfig.json"); // must call method, cannot set in initial props
copyDockerfiles();
bundle();
updateGitHubWorkflows();
generateStructs();
updatePackageJson();

project.synth();

function bundle() {
  const target = `node${nodeVersion}`;
  project.bundler.addBundle("src/nextjs-build/cdk-nextjs-cache-handler.ts", {
    platform: "node",
    target,
    outfile: "../../../lib/nextjs-build/cdk-nextjs-cache-handler.cjs",
    externals: ["next"],
  });
  project.bundler.addBundle("src/lambdas/assets-deployment/patch-fetch.js", {
    platform: "browser",
    // https://nextjs.org/docs/architecture/supported-browsers
    target: "chrome64,firefox67,safari12,edge79",
    minify: true,
    outfile: "../assets-deployment.lambda/patch-fetch.js",
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
  // .github/workflows/release.yml
  const releaseWorkflow = project.github?.tryFindWorkflow("release");
  if (!releaseWorkflow) return;
  const releaseJob = releaseWorkflow.getJob("release");
  if (!releaseJob || !("steps" in releaseJob)) return;
  const releaseJobSteps = releaseJob.steps;
  releaseWorkflow.updateJob("release", {
    ...releaseJob,
    steps: [
      ...releaseJobSteps.slice(0, 5),
      {
        name: "Compile JSII",
        run: `pnpm projen compile`,
      },
      ...releaseJobSteps.slice(5),
    ],
  });
  // .github/workflows/upgrade-main.yml
  const upgradeMainWorkflow = project.github?.tryFindWorkflow("upgrade-main");
  if (!upgradeMainWorkflow) return;
  const upgradeJob = upgradeMainWorkflow.getJob("upgrade");
  if (!upgradeJob || !("steps" in upgradeJob)) return;
  const upgradeJobSteps = upgradeJob.steps;
  upgradeMainWorkflow.updateJob("upgrade", {
    ...upgradeJob,
    steps: [
      ...upgradeJobSteps.slice(0, 4),
      {
        name: "Compile JSII",
        run: `pnpm projen compile`,
      },
      ...upgradeJobSteps.slice(4),
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
    name: "OptionalNextjsPostDeployProps",
    filePath: getFilePath("OptionalNextjsPostDeployProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsPostDeployProps"))
    .omit("overrides")
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalPostDeployCustomResourceProperties",
    filePath: getFilePath("OptionalPostDeployCustomResourceProperties"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.PostDeployCustomResourceProperties"))
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalCustomResourceProps",
    filePath: getFilePath("OptionalCustomResourceProps"),
  })
    .mixin(Struct.fromFqn("aws-cdk-lib.CustomResourceProps"))
    .allOptional();
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
    .omit("overrides")
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalNextjsDistributionProps",
    filePath: getFilePath("OptionalNextjsDistributionProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsDistributionProps"))
    .omit("overrides")
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalNextjsVpcProps",
    filePath: getFilePath("OptionalNextjsVpcProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsVpcProps"))
    .omit("overrides")
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalNextjsFileSystemProps",
    filePath: getFilePath("OptionalNextjsFileSystemProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsFileSystemProps"))
    .omit("overrides")
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalNextjsAssetsDeploymentProps",
    filePath: getFilePath("OptionalNextjsAssetsDeploymentProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsAssetsDeploymentProps"))
    .omit("overrides")
    .allOptional();
  new ProjenStruct(project, {
    name: "OptionalNextjsContainersProps",
    filePath: getFilePath("OptionalNextjsContainersProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsContainersProps"))
    .omit("overrides")
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

function updatePackageJson() {
  const packageJson = project.tryFindObjectFile("package.json");
  packageJson?.patch(
    JsonPatch.add("/pnpm/onlyBuiltDependencies", ["esbuild", "unrs-resolver"]),
  );
  packageJson?.patch(JsonPatch.add("/packageManager", "pnpm@10.11.0"));
}
