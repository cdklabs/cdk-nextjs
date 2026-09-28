/* eslint-disable import/no-extraneous-dependencies */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { Distribution } from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Architecture } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import {
  NextjsGlobalContainers,
  NextjsGlobalFunctions,
  NextjsRegionalContainers,
  NextjsRegionalFunctions,
} from "../src";

/**
 * Root-construct synth without `next build`: `NextjsBuild` is the one construct
 * that runs the build and installs `sharp`, so it is replaced by a stub exposing
 * what the root constructs read off it, pointed at a hand-made build directory.
 * Everything downstream of it — functions, URLs, grants, distribution, API — is
 * the real code.
 */
let buildDir: string;
let nextConfigBasePath = "";
let relativeProjectDir = "";

jest.mock("../src/nextjs-build/nextjs-build", () => {
  const actual = jest.requireActual("../src/nextjs-build/nextjs-build");
  class StubNextjsBuild extends Construct {
    readonly buildId = "test-build";
    readonly nextBuildId = "next-build";
    readonly publicDirEntries = [{ name: "favicon.ico", isDirectory: false }];
    readonly nextConfigBasePath = nextConfigBasePath;
    readonly nextConfigAssetPrefix = "";
    readonly nextConfigAssetPrefixPath = "";
    readonly relativeProjectDir = relativeProjectDir;
    readonly relativePathToEntrypoint = "cdk-nextjs-runtime/server.mjs";
    readonly trailingSlash = false;
    readonly initCacheDir = join(buildDir, ".next", "cdk-nextjs-init-cache");
    readonly deploymentRoots: {
      name: string;
      path: string;
      routes: string[];
    }[];
    readonly architecture: unknown;
    constructor(scope: Construct, id: string, props: any) {
      super(scope, id);
      this.deploymentRoots = [
        { name: "default", path: join(buildDir, "root-default"), routes: [] },
        ...(props.functionGroups ?? []).map((group: any) => ({
          name: group.name,
          path: join(buildDir, `root-${group.name}`),
          routes: group.routes,
        })),
      ];
      this.architecture = actual.deploymentArchitecture(props);
    }
  }
  return { ...actual, NextjsBuild: StubNextjsBuild };
});

function write(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(() => {
  buildDir = mkdtempSync(join(tmpdir(), "root-constructs-test-"));
  write(join(buildDir, "public", "favicon.ico"), "icon");
  write(join(buildDir, ".next", "static", "chunks", "main.js"), "// main");
  for (const name of ["default", "reports"]) {
    write(join(buildDir, `root-${name}`, "index.js"), `// ${name}`);
  }
});

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

beforeEach(() => {
  nextConfigBasePath = "";
  relativeProjectDir = "";
});

const functionGroups = [{ name: "reports", routes: ["/reports"] }];

/** Every Lambda that serves the app, keyed by its function group. */
function appFunctions(template: Template) {
  const functions = template.findResources("AWS::Lambda::Function", {
    Properties: {
      Environment: {
        Variables: { CDK_NEXTJS_FUNCTION_GROUP: Match.anyValue() },
      },
    },
  });
  return Object.fromEntries(
    Object.entries(functions).map(([logicalId, fn]) => [
      fn.Properties.Environment.Variables.CDK_NEXTJS_FUNCTION_GROUP,
      logicalId,
    ]),
  );
}

/** Every IAM action granted to the role of the function `logicalId`. */
function actionsOf(template: Template, logicalId: string): string[] {
  const fn = template.toJSON().Resources[logicalId];
  return actionsOfRole(template, fn.Properties.Role["Fn::GetAtt"][0]);
}

function actionsOfRole(template: Template, roleId: string): string[] {
  const policies = template.findResources("AWS::IAM::Policy");
  return Object.values(policies)
    .filter((policy) =>
      policy.Properties.Roles.some((role: any) => role.Ref === roleId),
    )
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
    .flatMap((statement: any) => [statement.Action].flat());
}

function expectCacheGrants(template: Template, logicalId: string) {
  expectCacheActions(actionsOf(template, logicalId));
  const fn = template.toJSON().Resources[logicalId];
  expectTableScopedDynamoGrants(template, fn.Properties.Role["Fn::GetAtt"][0]);
}

/**
 * Every DynamoDB statement on `roleId`'s policies names the revalidation table
 * (or its indexes), never `*`: the `'use cache'` log's `Query` and `PutItem`
 * included.
 */
function expectTableScopedDynamoGrants(template: Template, roleId: string) {
  const [tableId] = Object.keys(
    template.findResources("AWS::DynamoDB::GlobalTable"),
  );
  const statements = Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((policy) =>
      policy.Properties.Roles.some((role: any) => role.Ref === roleId),
    )
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
    .filter((statement: any) =>
      [statement.Action]
        .flat()
        .some((action: string) => action.startsWith("dynamodb:")),
    );
  const actions = statements.flatMap((statement: any) =>
    [statement.Action].flat(),
  );
  expect(actions).toEqual(
    expect.arrayContaining(["dynamodb:Query", "dynamodb:PutItem"]),
  );
  for (const statement of statements) {
    for (const resource of [statement.Resource].flat()) {
      expect(resource).not.toBe("*");
      expect(JSON.stringify(resource)).toContain(tableId);
    }
  }
}

/** The task role of the one ECS task definition in the stack. */
function taskRoleActions(template: Template): string[] {
  return actionsOfRole(template, taskRoleId(template));
}

function taskRoleId(template: Template): string {
  const [taskDefinition] = Object.values(
    template.findResources("AWS::ECS::TaskDefinition"),
  );
  return taskDefinition.Properties.TaskRoleArn["Fn::GetAtt"][0];
}

function expectCacheActions(actions: string[]) {
  // The cache bucket (read/write), the revalidation table, the static assets
  // bucket (the image optimizer's sources).
  expect(actions).toEqual(
    expect.arrayContaining([
      "s3:GetObject*",
      "s3:PutObject",
      "s3:DeleteObject*",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:Query",
    ]),
  );
}

describe("NextjsGlobalFunctions", () => {
  it("serves every group through an AWS_IAM, streaming Function URL with cache grants", () => {
    const stack = new Stack(new App(), "Stack");
    new NextjsGlobalFunctions(stack, "App", {
      buildDirectory: buildDir,
      functionGroups,
    });
    const template = Template.fromStack(stack);

    const groups = appFunctions(template);
    expect(Object.keys(groups).sort()).toEqual(["default", "reports"]);

    const urls = template.findResources("AWS::Lambda::Url");
    expect(Object.keys(urls)).toHaveLength(2);
    for (const url of Object.values(urls)) {
      expect(url.Properties.AuthType).toBe("AWS_IAM");
      expect(url.Properties.InvokeMode).toBe("RESPONSE_STREAM");
    }
    // Each URL belongs to one of the groups, none left without one.
    const targets = Object.values(urls).map(
      (url) => url.Properties.TargetFunctionArn["Fn::GetAtt"][0],
    );
    expect(targets.sort()).toEqual(Object.values(groups).sort());

    for (const logicalId of Object.values(groups)) {
      expectCacheGrants(template, logicalId);
    }
    // Reached only through CloudFront's OAC.
    template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: "lambda",
        SigningBehavior: "always",
      }),
    });
    // And invocable only by this distribution, on every group.
    const [distributionId] = Object.keys(
      template.findResources("AWS::CloudFront::Distribution"),
    );
    const invokers = Object.values(
      template.findResources("AWS::Lambda::Permission", {
        Properties: { Action: "lambda:InvokeFunction" },
      }),
    );
    expect(invokers).toHaveLength(2);
    for (const permission of invokers) {
      expect(permission.Properties.Principal).toBe("cloudfront.amazonaws.com");
      expect(JSON.stringify(permission.Properties.SourceArn)).toContain(
        distributionId,
      );
    }
  });

  describe("architecture", () => {
    function architectures(props: object) {
      const stack = new Stack(new App(), "Stack");
      new NextjsGlobalFunctions(stack, "App", {
        buildDirectory: buildDir,
        ...props,
      });
      const template = Template.fromStack(stack);
      const resources = template.toJSON().Resources;
      return Object.fromEntries(
        Object.entries(appFunctions(template)).map(([group, logicalId]) => [
          group,
          resources[logicalId].Properties.Architectures,
        ]),
      );
    }

    const host = process.arch.startsWith("arm") ? "arm64" : "x86_64";
    const other = host === "arm64" ? Architecture.X86_64 : Architecture.ARM_64;

    // So any native dependency `next build` traced from this machine runs.
    it("defaults to the synth machine's architecture on every group", () => {
      expect(architectures({ functionGroups })).toEqual({
        default: [host],
        reports: [host],
      });
    });

    it("honors functionProps.architecture construct-wide, and only there", () => {
      expect(
        architectures({
          functionGroups,
          overrides: {
            nextjsFunctions: {
              functionProps: { architecture: other },
            },
          },
        }),
      ).toEqual({ default: [other.name], reports: [other.name] });
      // One architecture per deployment.
      expect(() =>
        architectures({
          functionGroups: [
            {
              ...functionGroups[0],
              overrides: {
                functionProps: { architecture: other },
              },
            },
          ],
        }),
      ).toThrow(/function group "reports" is/);
    });
  });

  it("adds its behaviors to a distribution passed in instead of creating one", () => {
    nextConfigBasePath = "shop";
    const stack = new Stack(new App(), "Stack");
    const distribution = new Distribution(stack, "Shared", {
      defaultBehavior: { origin: new HttpOrigin("example.com") },
    });
    const app = new NextjsGlobalFunctions(stack, "App", {
      buildDirectory: buildDir,
      distribution,
    });
    expect(app.nextjsDistribution.distribution).toBe(distribution);
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({ PathPattern: "/shop/*" }),
        ]),
      }),
    });
  });

  it("never creates a Function URL with authType NONE", () => {
    const stack = new Stack(new App(), "Stack");
    new NextjsGlobalFunctions(stack, "App", { buildDirectory: buildDir });
    Template.fromStack(stack).resourcePropertiesCountIs(
      "AWS::Lambda::Url",
      { AuthType: "NONE" },
      0,
    );
  });
});

describe("NextjsRegionalFunctions", () => {
  it("creates no Function URL and grants every group the cache", () => {
    const stack = new Stack(new App(), "Stack");
    new NextjsRegionalFunctions(stack, "App", {
      buildDirectory: buildDir,
      functionGroups,
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::Lambda::Url", 0);
    const groups = appFunctions(template);
    expect(Object.keys(groups).sort()).toEqual(["default", "reports"]);
    for (const logicalId of Object.values(groups)) {
      expectCacheGrants(template, logicalId);
    }
  });

  it("derives basePath from a stage name set through overrides.nextjsApi", () => {
    // An app at the "v1" stage has to mount at the root, not under "v1".
    nextConfigBasePath = "v1";
    const stack = new Stack(new App(), "Stack");
    const app = new NextjsRegionalFunctions(stack, "App", {
      buildDirectory: buildDir,
      overrides: {
        nextjsApi: {
          restApiProps: { deployOptions: { stageName: "v1" } },
        },
      },
    });
    expect(app.nextjsStaticAssets.keyPrefix).toBe("");
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::ApiGateway::Stage", {
      StageName: "v1",
    });
    template.resourcePropertiesCountIs(
      "AWS::ApiGateway::Resource",
      { PathPart: "v1" },
      0,
    );
  });

  it('mounts at the root with basePath "/" for a domain synth cannot see', () => {
    nextConfigBasePath = "v1";
    const stack = new Stack(new App(), "Stack");
    const app = new NextjsRegionalFunctions(stack, "App", {
      buildDirectory: buildDir,
      basePath: "/",
    });
    expect(app.nextjsStaticAssets.keyPrefix).toBe("");
    Template.fromStack(stack).resourcePropertiesCountIs(
      "AWS::ApiGateway::Resource",
      { PathPart: "v1" },
      0,
    );
  });
});

describe("NextjsGlobalContainers", () => {
  it("grants the task role the cache and creates no Function URL", () => {
    const stack = new Stack(new App(), "Stack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    new NextjsGlobalContainers(stack, "App", {
      buildDirectory: buildDir,
      healthCheckPath: "/api/health",
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Lambda::Url", 0);
    template.resourceCountIs("AWS::ECS::Service", 1);
    expectCacheActions(taskRoleActions(template));
    expectTableScopedDynamoGrants(template, taskRoleId(template));

    // The ALB origin doesn't depend on the task, so it gets the distribution
    // ID itself and an invalidation grant on that distribution alone.
    const [distributionId] = Object.keys(
      template.findResources("AWS::CloudFront::Distribution"),
    );
    template.resourceCountIs("AWS::SSM::Parameter", 0);
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            {
              Name: "CDK_NEXTJS_DISTRIBUTION_ID",
              Value: { Ref: distributionId },
            },
          ]),
        }),
      ]),
    });
    const invalidation = Object.values(
      template.findResources("AWS::IAM::Policy"),
    )
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .find(
        (statement: any) =>
          statement.Action === "cloudfront:CreateInvalidation",
      );
    expect(JSON.stringify(invalidation.Resource)).toContain(distributionId);
  });
});

describe("NextjsRegionalContainers", () => {
  it("synthesizes an ALB-fronted service", () => {
    const stack = new Stack(new App(), "Stack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    new NextjsRegionalContainers(stack, "App", {
      buildDirectory: buildDir,
      healthCheckPath: "/api/health",
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Lambda::Url", 0);
    template.resourceCountIs("AWS::ECS::Service", 1);
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 1);
    expectCacheActions(taskRoleActions(template));
    expectTableScopedDynamoGrants(template, taskRoleId(template));
  });
  // The regional Dockerfile copies `.next/static` and `public` under
  // RELATIVE_PROJECT_DIR; losing it puts them at the image root, and a monorepo
  // app's assets 404.
  it("keeps RELATIVE_PROJECT_DIR when overrides add buildArgs", () => {
    relativeProjectDir = "apps/web";
    const app = new App();
    const stack = new Stack(app, "Stack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    new NextjsRegionalContainers(stack, "App", {
      buildDirectory: buildDir,
      healthCheckPath: "/api/health",
      overrides: {
        nextjsContainers: {
          dockerImageAssetProps: { buildArgs: { FOO: "bar" } },
        },
      },
    });
    const images = Object.values(
      JSON.parse(
        readFileSync(join(app.synth().directory, "Stack.assets.json"), "utf8"),
      ).dockerImages,
    ) as { source: { dockerBuildArgs?: Record<string, string> } }[];
    expect(images.map((image) => image.source.dockerBuildArgs)).toEqual([
      { RELATIVE_PROJECT_DIR: "apps/web", FOO: "bar" },
    ]);
  });
});

describe("static assets read grant", () => {
  /** The static assets bucket objects `s3:GetObject*` reaches, per role. */
  function staticReadObjects(template: Template, roleId: string): string[] {
    return Object.values(template.findResources("AWS::IAM::Policy"))
      .filter((policy) =>
        policy.Properties.Roles.some((role: any) => role.Ref === roleId),
      )
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) =>
        [statement.Action].flat().includes("s3:GetObject*"),
      )
      .flatMap((statement: any) => [statement.Resource].flat())
      .filter(
        (resource: any) =>
          resource["Fn::Join"] &&
          JSON.stringify(resource).includes("NextjsStaticAssetsBucket"),
      )
      .map((resource: any) => resource["Fn::Join"][1][1]);
  }

  // Several apps can share one bucket under different basePaths; each reads
  // only its own objects.
  it("is scoped to the app's key prefix on every group", () => {
    nextConfigBasePath = "base";
    const stack = new Stack(new App(), "Stack");
    new NextjsGlobalFunctions(stack, "App", {
      buildDirectory: buildDir,
      functionGroups,
    });
    const template = Template.fromStack(stack);
    const resources = template.toJSON().Resources;
    const groups = appFunctions(template);
    expect(Object.keys(groups)).toHaveLength(2);
    for (const logicalId of Object.values(groups)) {
      const roleId = resources[logicalId].Properties.Role["Fn::GetAtt"][0];
      expect(staticReadObjects(template, roleId)).toEqual(["/base/*"]);
    }
  });
});

describe("architecture through nextjsFunctionsProps.overrides", () => {
  // That override replaces `overrides.nextjsFunctions` wholesale, so the build
  // has to stage `sharp` for the architecture it names.
  it("is forwarded to NextjsBuild instead of throwing", () => {
    const other = process.arch.startsWith("arm")
      ? Architecture.X86_64
      : Architecture.ARM_64;
    const stack = new Stack(new App(), "Stack");
    new NextjsGlobalFunctions(stack, "App", {
      buildDirectory: buildDir,
      overrides: {
        nextjsGlobalFunctions: {
          nextjsFunctionsProps: {
            overrides: { functionProps: { architecture: other } },
          } as any,
        },
      },
    });
    const template = Template.fromStack(stack);
    const resources = template.toJSON().Resources;
    expect(
      resources[appFunctions(template).default].Properties.Architectures,
    ).toEqual([other.name]);
  });
});

describe("REST API stage redeploy", () => {
  it("NextjsRegionalFunctions redeploys its stage after each stack update", () => {
    const stack = new Stack(new App(), "Stack");
    new NextjsRegionalFunctions(stack, "App", { buildDirectory: buildDir });
    const template = Template.fromStack(stack);

    template.resourceCountIs("AWS::Events::Rule", 1);
    template.hasResourceProperties("AWS::Events::Rule", {
      EventPattern: Match.objectLike({ source: ["aws.cloudformation"] }),
    });
  });

  it("can be turned off through nextjsApiProps", () => {
    const stack = new Stack(new App(), "Stack");
    new NextjsRegionalFunctions(stack, "App", {
      buildDirectory: buildDir,
      overrides: {
        nextjsRegionalFunctions: {
          nextjsApiProps: { redeployAfterUpdate: false },
        },
      },
    });

    Template.fromStack(stack).resourceCountIs("AWS::Events::Rule", 0);
  });
});
