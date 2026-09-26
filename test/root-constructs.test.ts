/* eslint-disable import/no-extraneous-dependencies */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
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

jest.mock("../src/nextjs-build/nextjs-build", () => {
  const actual = jest.requireActual("../src/nextjs-build/nextjs-build");
  class StubNextjsBuild extends Construct {
    readonly buildId = "test-build";
    readonly nextBuildId = "next-build";
    readonly publicDirEntries = [{ name: "favicon.ico", isDirectory: false }];
    readonly nextConfigBasePath = nextConfigBasePath;
    readonly nextConfigAssetPrefix = "";
    readonly nextConfigAssetPrefixPath = "";
    readonly relativeProjectDir = "";
    readonly relativePathToEntrypoint = "cdk-nextjs-runtime/server.mjs";
    readonly hasDataRoutes = false;
    readonly trailingSlash = false;
    readonly initCacheDir = join(buildDir, ".next", "cdk-nextjs-init-cache");
    readonly deploymentRoots: {
      name: string;
      path: string;
      routes: string[];
    }[];
    readonly deploymentRootPath: string;
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
      this.deploymentRootPath = this.deploymentRoots[0].path;
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

  it("derives basePath from a stage name set through nextjsApiProps.overrides", () => {
    // `nextjsApiProps` is spread over NextjsApi's props last, so its
    // `overrides` is the one the RestApi is built from: an app at the "v1"
    // stage has to mount at the root, not under "v1".
    nextConfigBasePath = "v1";
    const stack = new Stack(new App(), "Stack");
    const app = new NextjsRegionalFunctions(stack, "App", {
      buildDirectory: buildDir,
      overrides: {
        nextjsRegionalFunctions: {
          nextjsApiProps: {
            overrides: { restApiProps: { deployOptions: { stageName: "v1" } } },
          } as any,
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
});
