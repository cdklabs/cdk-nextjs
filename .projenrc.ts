import { join } from "node:path";
import { ProjenStruct, Struct } from "@mrgrain/jsii-struct-builder";
import { CdklabsConstructLibrary } from "cdklabs-projen-project-types";
import { javascript, JsonPatch, ReleasableCommits } from "projen";
import { LambdaRuntime } from "projen/lib/awscdk";
import { JobStep } from "projen/lib/github/workflows-model";
import { UpgradeDependenciesSchedule } from "projen/lib/javascript";

const nodeVersion = 24;
const pnpmVersion = "10.32.1";
const project = new CdklabsConstructLibrary({
  // repository config
  author: "Ben Stickley",
  authorAddress: "bestickley@gmail.com",
  defaultReleaseBranch: "main",
  repositoryUrl: "https://github.com/cdklabs/cdk-nextjs.git",
  private: false,
  // package.json config
  name: "cdk-nextjs",
  description:
    "Deploy Next.js apps on AWS with CDK" /* The description is just a string that helps people understand the purpose of the package. */,
  // majorVersion: 1,
  keywords: ["nextjs", "next", "next.js", "aws-cdk", "aws", "cdk"],
  cdkVersion: "2.261.0",
  jsiiVersion: "~6.0.4",
  packageManager: javascript.NodePackageManager.PNPM,
  pnpmVersion,
  projenVersion: "^0.101.6",
  devDeps: [
    "@aws-crypto/sha256-js",
    "@aws-sdk/client-cloudfront",
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/client-s3",
    "@aws-sdk/client-ssm",
    "@aws-sdk/lib-storage",
    "@mrgrain/jsii-struct-builder",
    // Exact-pinned to `next` and bumped with it: it is first-party and versioned
    // in lockstep, so a mismatch is a routing behavior difference. Bundled into
    // the runtime by esbuild, not resolved from the deployment tree.
    "@next/routing@16.3.5",
    "@smithy/signature-v4",
    "@types/aws-lambda",
    "@types/debug",
    "@types/mime-types",
    "@types/node@^24",
    "cdk-nag",
    "debug",
    "esbuild",
    "mime-types",
    "next@^16.3.5", // bundled in src/nextjs-build/cache-handler.ts
    "undici",
  ],
  setNodeEngineVersion: false,
  npmIgnoreOptions: {
    ignorePatterns: ["examples/**/*"],
  },
  // tooling config
  rosettaOptions: {
    strict: false,
  },
  enablePRAutoMerge: true,
  depsUpgradeOptions: {
    workflowOptions: {
      schedule: UpgradeDependenciesSchedule.MONTHLY,
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
  jestOptions: {
    jestConfig: {
      testPathIgnorePatterns: ["/node_modules/", "/cdk.out/"],
    },
  },
  projenCommand: "pnpm dlx projen",
  gitignore: [
    ".idea",
    ".DS_Store",
    "*.drawio.bkp",
    "ash_output",
    "~$*.xlsx",
    ".kiro",
    ".claude/worktrees",
  ],
  projenrcTs: true,
  // tsconfig: {
  //   exclude: [] // doesn't work for some reason, would like to exclude nextjs-build/* since only need bundled
  // },
  eslintOptions: {
    prettier: true,
    dirs: ["src"],
    ignorePatterns: ["generated-structs/", "**/*-function.ts", "examples/"],
  },
  sampleCode: false,
  jsiiTargetLanguages: [],
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
              commit_message_template: `{{ title }} (#{{ number }})

{{ body }}`,
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

// override cdklabs views on stability
project.package.addField("stability", "stable");

// by default projen ignores all tsconfigs, but we don't want do this for non-projen
// managed repo.
project.gitignore.addPatterns("!/examples/**/tsconfig.json"); // must call method, cannot set in initial props
copyDockerfiles();
bundle();
checkBundleSyntax();
typeCheckEsmSources();
updateGitHubWorkflows();
generateStructs();
updatePackageJson();

project.synth();

/**
 * Shims the CJS globals (`require`, `__dirname`, `__filename`) that bundled CJS
 * dependencies reference as bare identifiers but that don't exist in ESM scope.
 *
 * esbuild treats a banner as opaque text, so it cannot rename a source module's
 * imports out of the way of a name the banner declares: importing
 * `fileURLToPath` (or `createRequire`, or `dirname`) anywhere in the bundled
 * sources would emit a hoisted `import` of the same name at the top level and
 * the file would fail to parse with "Identifier ... has already been declared".
 * Hence the `__cdkNextjs` prefixes — only the three CJS globals themselves,
 * which no ESM source declares, keep their required names.
 */
function cjsGlobalsBanner() {
  return [
    "import { createRequire as __cdkNextjsCreateRequire } from 'node:module';",
    "import { fileURLToPath as __cdkNextjsFileURLToPath } from 'node:url';",
    "import { dirname as __cdkNextjsDirname } from 'node:path';",
    "const require = __cdkNextjsCreateRequire(import.meta.url);",
    "const __filename = __cdkNextjsFileURLToPath(import.meta.url);",
    "const __dirname = __cdkNextjsDirname(__filename);",
  ].join(" ");
}

function bundle() {
  const target = `node${nodeVersion}`;
  project.bundler.addBundle("src/adapter/cache-handler.ts", {
    platform: "node",
    target,
    outfile: "../../../lib/adapter/cache-handler.mjs",
    externals: ["next"],
    format: "esm",
    banner:
      "const require = (await import('node:module')).createRequire(import.meta.url);",
  });
  project.bundler.addBundle("src/adapter/adapter.mts", {
    platform: "node",
    target,
    outfile: "../../../lib/adapter/adapter.mjs",
    externals: ["next"],
    format: "esm",
    banner:
      "const require = (await import('node:module')).createRequire(import.meta.url);",
  });
  project.bundler.addBundle("src/nextjs-build/patch-fetch.js", {
    platform: "browser",
    // https://nextjs.org/docs/architecture/supported-browsers
    target: "chrome111,firefox111,safari16.4,edge111",
    minify: true,
    outfile: "../../../lib/nextjs-build/patch-fetch.js",
  });
  project.bundler.addBundle("src/image-optimization/handler.mts", {
    platform: "node",
    target,
    outfile: "../../../lib/image-optimization/handler.mjs",
    // Unlike adapter.mts/cache-handler.ts, this Lambda doesn't run inside the
    // customer's own Next.js server process, so "next" must be bundled in.
    // "sharp" stays external: it's a native binary vendored separately by
    // NextjsBuild into node_modules alongside this bundle. "@opentelemetry/api"
    // stays external too: next/dist/server/lib/trace/tracer.js requires it in
    // a try/catch and falls back to its own vendored copy when missing.
    externals: ["sharp", "@opentelemetry/api"],
    format: "esm",
    // Unlike the other bundles' await-import banner, this one must shim
    // `require`/`__dirname`/`__filename` via static imports: this bundle
    // inlines Next.js's compiled internals (e.g. next/dist/compiled/@hapi/accept),
    // which reference those as bare CJS globals (even if unused at runtime,
    // e.g. nccwpck's `__nccwpck_require__.ab = __dirname + "/"` boilerplate
    // present in every compiled module). A top-level await banner combined
    // with that `__dirname` reference makes Node's ESM/CJS format detection
    // refuse to load the file ("Cannot determine intended module format"),
    // and even once that's avoided, `__dirname`/`__filename` simply don't
    // exist in real ESM scope, so they must be defined too.
    banner: cjsGlobalsBanner(),
  });
  // The two request-handling shells. "next" stays external: the deployment
  // already carries the traced `next` files every built entrypoint requires, and
  // a second bundled copy would be a different module instance of the same
  // singletons. "@next/routing" and the AWS SDK are bundled (see devDeps).
  for (const shell of ["lambda", "server"]) {
    project.bundler.addBundle(`src/runtime/${shell}.mts`, {
      platform: "node",
      target,
      outfile: `../../../lib/runtime/${shell}.mjs`,
      externals: ["next", "sharp", "@opentelemetry/api"],
      format: "esm",
      // Same reasoning as the image handler above: bundled CJS dependencies
      // reference `require`/`__dirname`/`__filename` as bare globals, which do
      // not exist in ESM scope.
      banner: cjsGlobalsBanner(),
    });
  }
}

/**
 * `.mts` sources are bundled by esbuild, which does not type-check, and jsii's
 * `include` of `src/**\/*.ts` does not match `.mts` — so without this the runtime
 * shells and the build adapter would be the only unchecked code in the repo.
 *
 * A separate config rather than widening jsii's: these files are ESM with
 * `import.meta`, resolved the way esbuild resolves them (extensionless relative
 * imports), which is not how the JSII assembly is compiled.
 */
function typeCheckEsmSources() {
  const tsconfig = new javascript.TypescriptConfig(project, {
    fileName: "tsconfig.esm.json",
    extends: javascript.TypescriptConfigExtends.fromPaths(["./tsconfig.json"]),
    // The `.ts` files are included because the `.mts` entrypoints import them;
    // they are checked again here under ESM resolution rules.
    include: ["src/**/*.mts", "src/**/*.ts"],
    compilerOptions: {
      noEmit: true,
      declaration: false,
      noEmitOnError: false,
      module: "esnext",
      moduleResolution: javascript.TypeScriptModuleResolution.BUNDLER,
    },
  });
  project.compileTask.exec(`tsc -p ${tsconfig.fileName}`);
}

/**
 * Parses every bundle esbuild emits. Nothing else in the repo does: the bundles
 * are ESM run by Node in Lambda/Fargate, not by jest or jsii, so a bundle that
 * esbuild happily writes but Node cannot parse (see `cjsGlobalsBanner`) would
 * otherwise first surface as a `Runtime.UserCodeSyntaxError` in a deployment.
 */
function checkBundleSyntax() {
  const bundleTask = project.tasks.tryFind("bundle");
  if (!bundleTask) return;
  for (const bundled of [
    join("lib", "adapter", "adapter.mjs"),
    join("lib", "adapter", "cache-handler.mjs"),
    join("lib", "image-optimization", "handler.mjs"),
    join("lib", "runtime", "lambda.mjs"),
    join("lib", "runtime", "server.mjs"),
  ]) {
    bundleTask.exec(`node --check ${bundled}`);
  }
}

function copyDockerfiles() {
  const bundleTask = project.tasks.tryFind("bundle");
  if (bundleTask) {
    bundleTask.exec(`mkdir -p ${join("lib", "nextjs-build")}`);
    bundleTask.exec(
      `cp ${join("src", "nextjs-build", "global-containers.Dockerfile")} ${join("lib", "nextjs-build")}`,
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
  // .github/workflows/upgrade-cdklabs-projen-project-types-main.yml
  const upgradeCdklabsWorkflow = project.github?.tryFindWorkflow(
    "upgrade-cdklabs-projen-project-types-main",
  );
  if (!upgradeCdklabsWorkflow) return;
  const upgradeCdklabsJob = upgradeCdklabsWorkflow.getJob("upgrade");
  if (!upgradeCdklabsJob || !("steps" in upgradeCdklabsJob)) return;
  const upgradeCdklabsJobSteps = upgradeCdklabsJob.steps;
  upgradeCdklabsWorkflow.updateJob("upgrade", {
    ...upgradeCdklabsJob,
    steps: [
      ...upgradeCdklabsJobSteps.slice(0, 4),
      {
        name: "Compile JSII",
        run: `pnpm projen compile`,
      },
      ...upgradeCdklabsJobSteps.slice(4),
    ],
  });
  // .github/workflows/upgrade-dev-deps-main.yml
  const upgradeDevDepsWorkflow = project.github?.tryFindWorkflow(
    "upgrade-dev-deps-main",
  );
  if (!upgradeDevDepsWorkflow) return;
  const upgradeDevDepsJob = upgradeDevDepsWorkflow.getJob("upgrade");
  if (!upgradeDevDepsJob || !("steps" in upgradeDevDepsJob)) return;
  const upgradeDevDepsJobSteps = upgradeDevDepsJob.steps;
  upgradeDevDepsWorkflow.updateJob("upgrade", {
    ...upgradeDevDepsJob,
    steps: [
      ...upgradeDevDepsJobSteps.slice(0, 4),
      {
        name: "Compile JSII",
        run: `pnpm projen compile`,
      },
      ...upgradeDevDepsJobSteps.slice(4),
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
    name: "OptionalNextjsCacheProps",
    filePath: getFilePath("OptionalNextjsCacheProps"),
  })
    .mixin(Struct.fromFqn("cdk-nextjs.NextjsCacheProps"))
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
    JsonPatch.add("/pnpm/onlyBuiltDependencies", [
      "esbuild",
      "unrs-resolver",
      "sharp",
    ]),
  );
  packageJson?.patch(
    JsonPatch.add("/pnpm/overrides", {
      postcss: "^8.5.23",
      browserslist: "^4.28.7",
      "js-yaml@3": "^3.15.1",
      "js-yaml@4": "^4.3.1",
      "brace-expansion@1": "^1.1.18",
      "brace-expansion@5": "^5.0.9",
      "@babel/core": "^7.29.6",
    }),
  );
  packageJson?.patch(JsonPatch.add("/packageManager", `pnpm@${pnpmVersion}`));
  packageJson?.patch(
    JsonPatch.add("/exports", {
      ".": {
        types: "./lib/index.d.ts",
        import: "./lib/index.js",
        default: "./lib/index.js",
      },
      "./adapter": {
        import: "./lib/adapter/adapter.mjs",
        default: "./lib/adapter/adapter.mjs",
      },
      "./cache-handler": {
        import: "./lib/adapter/cache-handler.mjs",
        default: "./lib/adapter/cache-handler.mjs",
      },
    }),
  );
}
