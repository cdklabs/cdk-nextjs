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
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import {
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  Architecture,
  WebFunctionAuthType,
  WebFunctionEndpointLocation,
} from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import {
  NextjsGlobalContainers,
  NextjsGlobalFunctions,
  NextjsGlobalWebFunctions,
  NextjsGlobalWebFunctionsProps,
  NextjsRegionalContainers,
  NextjsRegionalFunctions,
} from "../src";
import { LAMBDA_RUNTIME } from "../src/lambda-runtime";

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
/**
 * What the build assigned each non-default group: the route templates that
 * matched its patterns, as `NextjsDeploymentRoot.routes`, and the behaviors it
 * checked them against, as `NextjsBuild.functionGroupBehaviors` (most specific
 * first).
 */
let builtGroups: Record<
  string,
  { routes: string[]; behaviors: { route: string; pattern: string }[] }
>;

jest.mock("../src/nextjs-build/nextjs-build", () => {
  const actual = jest.requireActual("../src/nextjs-build/nextjs-build");
  class StubNextjsBuild extends Construct {
    readonly buildId = "test-build";
    readonly publicDirEntries = [{ name: "favicon.ico", isDirectory: false }];
    readonly nextConfigBasePath = nextConfigBasePath;
    readonly nextConfigAssetPrefix = "";
    readonly nextConfigAssetPrefixPath = "";
    readonly relativeProjectDir = relativeProjectDir;
    readonly relativePathToEntrypoint = "cdk-nextjs-runtime/server.mjs";
    readonly initCacheDir = join(buildDir, ".next", "cdk-nextjs-init-cache");
    readonly deploymentRoots: {
      name: string;
      path: string;
      routes: string[];
    }[];
    readonly functionGroupBehaviors: {
      group: string;
      route: string;
      pattern: string;
    }[];
    readonly architecture: unknown;
    constructor(scope: Construct, id: string, props: any) {
      super(scope, id);
      const groups: { name: string }[] = props.functionGroups ?? [];
      this.deploymentRoots = [
        { name: "default", path: join(buildDir, "root-default"), routes: [] },
        ...groups.map((group) => ({
          name: group.name,
          path: join(buildDir, `root-${group.name}`),
          routes: builtGroups[group.name].routes,
        })),
      ];
      this.functionGroupBehaviors = groups.flatMap((group) =>
        builtGroups[group.name].behaviors.map((behavior) => ({
          group: group.name,
          ...behavior,
        })),
      );
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
  for (const name of ["default", "reports", "docs"]) {
    write(join(buildDir, `root-${name}`, "index.js"), `// ${name}`);
  }
});

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true });
});

beforeEach(() => {
  nextConfigBasePath = "";
  relativeProjectDir = "";
  builtGroups = {
    reports: {
      routes: ["/reports"],
      behaviors: [{ route: "/reports", pattern: "reports" }],
    },
  };
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

/** Every statement of the IAM policies attached to `roleId`. */
function statementsOfRole(template: Template, roleId: string): any[] {
  return Object.values(template.findResources("AWS::IAM::Policy"))
    .filter((policy) =>
      policy.Properties.Roles.some((role: any) => role.Ref === roleId),
    )
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}

function actionsOfRole(template: Template, roleId: string): string[] {
  return statementsOfRole(template, roleId).flatMap((statement) =>
    [statement.Action].flat(),
  );
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
  const statements = statementsOfRole(template, roleId).filter((statement) =>
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

/** The group whose function `json` (a template fragment) refers to, if any. */
function groupIn(template: Template, json: unknown): string | undefined {
  const text = JSON.stringify(json);
  return Object.entries(appFunctions(template)).find(([, logicalId]) =>
    text.includes(`"${logicalId}"`),
  )?.[0];
}

/**
 * The split a subtree pattern over an optional catch-all makes, as the build
 * reports it: the template it matched, not the pattern, the optional
 * catch-all's parent routed too, and a Pages Router route, so a `_next/data`
 * URL space as well.
 */
function useDocsGroup() {
  builtGroups.docs = {
    routes: ["/docs/[[...slug]]"],
    behaviors: [
      { route: "/docs", pattern: "_next/data/next-build/docs.json" },
      { route: "/docs/**", pattern: "_next/data/next-build/docs/*" },
      { route: "/docs", pattern: "docs" },
      { route: "/docs/**", pattern: "docs/*" },
    ],
  };
  return [{ name: "docs", routes: ["/docs/**"] }];
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
      // Through the Function URL only, not the plain Invoke API.
      expect(permission.Properties.InvokedViaFunctionUrl).toBe(true);
      expect(JSON.stringify(permission.Properties.SourceArn)).toContain(
        distributionId,
      );
    }
    // Invalidation is scoped to this distribution, in one policy of its own
    // on every group: the functions' default policies naming it would be a
    // cycle through the Function URL origin, which `Template.fromStack` above
    // rejects as undeployable.
    const roleIds = Object.values(groups).map(
      (id) => template.toJSON().Resources[id].Properties.Role["Fn::GetAtt"][0],
    );
    const invalidation = Object.values(
      template.findResources("AWS::IAM::Policy"),
    ).filter((policy) =>
      policy.Properties.PolicyDocument.Statement.some(
        (statement: any) =>
          statement.Action === "cloudfront:CreateInvalidation" &&
          policy.Properties.Roles.some((role: any) =>
            roleIds.includes(role.Ref),
          ),
      ),
    );
    expect(invalidation).toHaveLength(1);
    const [policy] = invalidation;
    expect(policy.Properties.Roles.map((role: any) => role.Ref).sort()).toEqual(
      roleIds.sort(),
    );
    const { Resource } = policy.Properties.PolicyDocument.Statement.find(
      (statement: any) => statement.Action === "cloudfront:CreateInvalidation",
    );
    expect(JSON.stringify(Resource)).toContain(distributionId);
    expect(JSON.stringify(Resource)).not.toContain("distribution/*");
  });

  it("leaves invalidation off when invalidateCdnOnRevalidate is false", () => {
    const stack = new Stack(new App(), "Stack");
    new NextjsGlobalFunctions(stack, "App", {
      buildDirectory: buildDir,
      functionGroups,
      invalidateCdnOnRevalidate: false,
    });
    const template = Template.fromStack(stack);
    // No parameter name, so the cache handler never invalidates; and no
    // grant, since nothing in the functions would use it.
    template.resourceCountIs("AWS::SSM::Parameter", 0);
    const groups = appFunctions(template);
    expect(Object.keys(groups).sort()).toEqual(["default", "reports"]);
    const resources = template.toJSON().Resources;
    for (const logicalId of Object.values(groups)) {
      expect(
        resources[logicalId].Properties.Environment.Variables,
      ).not.toHaveProperty("CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME");
      const actions = actionsOf(template, logicalId);
      expect(actions).not.toContain("cloudfront:CreateInvalidation");
      expect(actions).not.toContain("ssm:GetParameter");
      expectCacheGrants(template, logicalId);
    }
    // The invalidation after each deploy is not affected.
    template.resourceCountIs("Custom::NextjsPostDeploy", 1);
  });

  it("routes each group's patterns, parent and data URLs to its function", () => {
    const stack = new Stack(new App(), "Stack");
    new NextjsGlobalFunctions(stack, "App", {
      buildDirectory: buildDir,
      functionGroups: useDocsGroup(),
    });
    const template = Template.fromStack(stack);
    const resources = template.toJSON().Resources;
    const [distribution] = Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    );
    const { CacheBehaviors, Origins } =
      distribution.Properties.DistributionConfig;
    /** Origin id → group, through the Function URL the origin points at. */
    const originGroup = (originId: string) => {
      const origin = Origins.find((it: any) => it.Id === originId);
      const [urlId] = Object.keys(
        template.findResources("AWS::Lambda::Url"),
      ).filter((id) => JSON.stringify(origin).includes(`"${id}"`));
      return urlId && groupIn(template, resources[urlId].Properties);
    };
    const routed = Object.fromEntries(
      CacheBehaviors.map((behavior: any) => [
        behavior.PathPattern,
        originGroup(behavior.TargetOriginId),
      ]),
    );
    expect(routed).toMatchObject({
      "docs/*": "docs",
      // The optional catch-all's parent, which `docs/*` does not match, in
      // both URL spaces.
      docs: "docs",
      "_next/data/next-build/docs/*": "docs",
      "_next/data/next-build/docs.json": "docs",
      "_next/image*": "default",
    });
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

    const other = process.arch.startsWith("arm")
      ? Architecture.X86_64
      : Architecture.ARM_64;

    it("honors functionProps.architecture construct-wide", () => {
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

describe("NextjsGlobalWebFunctions", () => {
  const env = { region: "us-east-1" };

  function synth(props: Partial<NextjsGlobalWebFunctionsProps> = {}) {
    const stack = new Stack(new App(), "Stack", { env });
    const app = new NextjsGlobalWebFunctions(stack, "App", {
      buildDirectory: buildDir,
      ...props,
    });
    return { app, stack, template: Template.fromStack(stack) };
  }

  /** Every Web Function revision that serves the app, keyed by its group. */
  function revisions(template: Template) {
    const found = template.findResources("AWS::Lambda::WebFunctionRevision");
    return Object.fromEntries(
      Object.values(found).map((revision) => [
        revision.Properties.ServiceConfig.EnvironmentVariables
          .CDK_NEXTJS_FUNCTION_GROUP,
        revision.Properties,
      ]),
    );
  }

  it("serves every group through an IAM_AUTH, home-Region endpoint", () => {
    const { template } = synth({ functionGroups });
    template.resourceCountIs("AWS::Lambda::WebFunction", 2);
    const endpoints = Object.values(
      template.findResources("AWS::Lambda::WebFunctionEndpoint"),
    );
    expect(endpoints).toHaveLength(2);
    for (const endpoint of endpoints) {
      expect(endpoint.Properties.AuthType).toBe("IamAuth");
      expect(endpoint.Properties.EndpointType).toBe("HomeRegion");
      expect(endpoint.Properties.EndpointName).toBe("prod");
    }
    // No Event Function URL or permission is left over from Global Functions.
    template.resourceCountIs("AWS::Lambda::Url", 0);
    expect(
      template.findResources("AWS::Lambda::Permission", {
        Properties: { Principal: "cloudfront.amazonaws.com" },
      }),
    ).toEqual({});
  });

  it("runs LAMBDA_RUNTIME and the Web Function shell", () => {
    const { template } = synth({ functionGroups });
    for (const revision of Object.values(revisions(template))) {
      expect(revision.BuildConfig.RuntimeConfig.Runtime).toBe(
        LAMBDA_RUNTIME.name,
      );
      expect(revision.ServiceConfig.EnvironmentVariables).toMatchObject({
        AWS_LAMBDA_NODEJS_ENTRYPOINT: "cdk-nextjs-runtime/web-function.mjs",
        NODE_ENV: "production",
        // What the runtime trusts `x-forwarded-host` on.
        CDK_NEXTJS_TRUSTED_ENDPOINT_NAME: "prod",
        CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME: expect.stringMatching(
          /^cdk-nextjs-distribution-id-/,
        ),
      });
      // A revision rejects an empty value; the runtime reads unset as empty.
      for (const value of Object.values(
        revision.ServiceConfig.EnvironmentVariables,
      )) {
        expect(value).not.toBe("");
      }
      expect(revision.ServiceConfig.EnvironmentVariables).not.toHaveProperty(
        "CDK_NEXTJS_STATIC_ASSETS_KEY_PREFIX",
      );
      // Staged into a versioned bucket Lambda can read, not the bootstrap one.
      expect(JSON.stringify(revision.BuildConfig.CodeConfig)).not.toContain(
        "cdk-hnb659fds-assets",
      );
    }
  });

  it("grants CloudFront the endpoints, scoped to the distribution, in one policy per function", () => {
    const { template } = synth({ functionGroups });
    const [distributionId] = Object.keys(
      template.findResources("AWS::CloudFront::Distribution"),
    );
    const policies = Object.values(
      template.findResources("AWS::Lambda::ResourcePolicy"),
    );
    // A function has a single resource-based policy; a second policy
    // resource for the same function would replace the first.
    expect(policies).toHaveLength(2);
    const functionsWithPolicy = policies.map(
      (policy) => policy.Properties.ResourceArn["Fn::GetAtt"][0],
    );
    expect(new Set(functionsWithPolicy).size).toBe(2);
    for (const policy of policies) {
      const statements = policy.Properties.PolicyDocument.Statement;
      expect(statements).toHaveLength(1);
      const [statement] = statements;
      expect(statement).toMatchObject({
        Effect: "Allow",
        Action: "lambda:InvokeWebFunctionEndpoint",
        Principal: { Service: "cloudfront.amazonaws.com" },
      });
      expect(
        JSON.stringify(statement.Condition.ArnLike["aws:SourceArn"]),
      ).toContain(distributionId);
      expect(JSON.stringify(statement.Resource)).toContain("EndpointArn");
    }
  });

  it("reaches the endpoints through always-amz-auth OAC, without the viewer's Host", () => {
    const { template } = synth({ functionGroups });
    const controls = Object.values(
      template.findResources("AWS::CloudFront::OriginAccessControl", {
        Properties: {
          OriginAccessControlConfig: Match.objectLike({
            OriginAccessControlOriginType: "lambda",
          }),
        },
      }),
    );
    // One, shared by every group's origin.
    expect(controls).toHaveLength(1);
    expect(controls[0].Properties.OriginAccessControlConfig).toMatchObject({
      SigningBehavior: "always-amz-auth",
      SigningProtocol: "sigv4",
    });
    const [distribution] = Object.values(
      template.findResources("AWS::CloudFront::Distribution"),
    );
    const config = distribution.Properties.DistributionConfig;
    const endpointOrigins = config.Origins.filter((origin: any) =>
      /WebFunction\w*Endpoint/.test(JSON.stringify(origin.DomainName)),
    );
    expect(endpointOrigins).toHaveLength(2);
    for (const origin of endpointOrigins) {
      expect(origin.CustomOriginConfig.OriginProtocolPolicy).toBe("https-only");
      expect(origin.OriginAccessControlId).toBeDefined();
    }
    // `ALL_VIEWER_EXCEPT_HOST_HEADER`: a Web Function answers any `Host` but
    // its endpoint's with a 404.
    expect(config.DefaultCacheBehavior.OriginRequestPolicyId).toBe(
      "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    );
    // The viewer-request function that sets `x-forwarded-host`.
    expect(
      config.DefaultCacheBehavior.FunctionAssociations.map(
        (it: any) => it.EventType,
      ),
    ).toEqual(["viewer-request"]);
    // Which also sends a `+` in the query on as `%20`, which the endpoint's
    // signature check accepts.
    const functions = Object.values(
      template.findResources("AWS::CloudFront::Function"),
    ).map((fn) => fn.Properties.FunctionCode as string);
    expect(functions.some((code) => code.includes('"%20"'))).toBe(true);
    // And the group's routes reach the group's endpoint.
    const reports = config.CacheBehaviors.find(
      (behavior: any) => behavior.PathPattern === "reports",
    );
    const target = config.Origins.find(
      (origin: any) => origin.Id === reports.TargetOriginId,
    );
    expect(JSON.stringify(target.DomainName)).toContain(
      "WebFunctionreportsEndpoint",
    );
  });

  it("grants every group the cache, and invalidation through a policy of its own", () => {
    const { template } = synth({ functionGroups });
    const [distributionId] = Object.keys(
      template.findResources("AWS::CloudFront::Distribution"),
    );
    const roleIds = Object.values(revisions(template)).map(
      (revision) => revision.ServiceConfig.ExecutionRoleArn["Fn::GetAtt"][0],
    );
    expect(roleIds).toHaveLength(2);
    for (const roleId of roleIds) {
      expectCacheActions(actionsOfRole(template, roleId));
      expectTableScopedDynamoGrants(template, roleId);
    }
    const invalidation = Object.values(
      template.findResources("AWS::IAM::Policy"),
    ).filter((policy) =>
      policy.Properties.PolicyDocument.Statement.some(
        (statement: any) =>
          statement.Action === "cloudfront:CreateInvalidation" &&
          policy.Properties.Roles.some((role: any) =>
            roleIds.includes(role.Ref),
          ),
      ),
    );
    expect(invalidation).toHaveLength(1);
    expect(
      invalidation[0].Properties.Roles.map((role: any) => role.Ref).sort(),
    ).toEqual(roleIds.sort());
    expect(JSON.stringify(invalidation[0].Properties.PolicyDocument)).toContain(
      distributionId,
    );
  });

  it("leaves invalidation off when invalidateCdnOnRevalidate is false", () => {
    const { template } = synth({
      functionGroups,
      invalidateCdnOnRevalidate: false,
    });
    // No parameter name, so the cache handler never invalidates; and no
    // grant, since nothing in the functions would use it.
    template.resourceCountIs("AWS::SSM::Parameter", 0);
    const found = Object.values(revisions(template));
    expect(found).toHaveLength(2);
    for (const revision of found) {
      expect(revision.ServiceConfig.EnvironmentVariables).not.toHaveProperty(
        "CDK_NEXTJS_DISTRIBUTION_ID_PARAM_NAME",
      );
      const roleId = revision.ServiceConfig.ExecutionRoleArn["Fn::GetAtt"][0];
      const actions = actionsOfRole(template, roleId);
      expect(actions).not.toContain("cloudfront:CreateInvalidation");
      expect(actions).not.toContain("ssm:GetParameter");
      expectCacheActions(actions);
    }
    // The invalidation after each deploy is not affected.
    template.resourceCountIs("Custom::NextjsPostDeploy", 1);
  });

  it("deploys each revision after its role's cache grants", () => {
    const { template } = synth({ functionGroups });
    const resources = template.toJSON().Resources;
    const found = Object.values(
      template.findResources("AWS::Lambda::WebFunctionRevision"),
    );
    expect(found).toHaveLength(2);
    for (const revision of found) {
      const roleId =
        revision.Properties.ServiceConfig.ExecutionRoleArn["Fn::GetAtt"][0];
      const runtimePolicy = Object.keys(resources).find(
        (logicalId) =>
          resources[logicalId].Type === "AWS::IAM::Policy" &&
          logicalId.includes("RuntimePolicy") &&
          resources[logicalId].Properties.Roles.some(
            (role: any) => role.Ref === roleId,
          ),
      );
      expect(runtimePolicy).toBeDefined();
      expect(revision.DependsOn).toEqual(
        expect.arrayContaining([runtimePolicy]),
      );
    }
  });

  it("lets a role, its own or an override's, be granted the distribution", () => {
    for (const bringRole of [false, true]) {
      const stack = new Stack(new App(), "Stack", { env });
      const role = bringRole
        ? new Role(stack, "OwnRole", {
            assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
          })
        : undefined;
      const app = new NextjsGlobalWebFunctions(stack, "App", {
        buildDirectory: buildDir,
        overrides: role
          ? { nextjsWebFunctions: { webFunctionProps: { role } } }
          : undefined,
      });
      const [group] = app.nextjsWebFunctions.functionGroups;
      // Lands in the role's default policy, which names the distribution,
      // whose origin is the endpoint: a revision waiting on it is a cycle.
      app.nextjsDistribution.distribution.grantCreateInvalidation(group.role);
      const template = Template.fromStack(stack);
      const resources = template.toJSON().Resources;
      const found = Object.values(
        template.findResources("AWS::Lambda::WebFunctionRevision"),
      );
      expect(found).toHaveLength(1);
      const [revision] = found;
      // It waits on the cache grants, whoever made the role.
      const roleId =
        revision.Properties.ServiceConfig.ExecutionRoleArn["Fn::GetAtt"][0];
      const waitsOn = (revision.DependsOn ?? []).filter(
        (dependency: string) =>
          resources[dependency].Type === "AWS::IAM::Policy",
      );
      expect(waitsOn).toHaveLength(1);
      expect(waitsOn[0]).toContain("RuntimePolicy");
      expect(
        resources[waitsOn[0]].Properties.Roles.map((it: any) => it.Ref),
      ).toEqual([roleId]);
      expect(
        JSON.stringify(resources[waitsOn[0]].Properties.PolicyDocument),
      ).not.toContain("cloudfront");
    }
  });

  it("grants a role groups share once, and every group waits on it", () => {
    const stack = new Stack(new App(), "Stack", { env });
    const role = new Role(stack, "OwnRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });
    new NextjsGlobalWebFunctions(stack, "App", {
      buildDirectory: buildDir,
      functionGroups,
      overrides: { nextjsWebFunctions: { webFunctionProps: { role } } },
    });
    const template = Template.fromStack(stack);
    const runtimePolicies = Object.keys(
      template.findResources("AWS::IAM::Policy"),
    ).filter((logicalId) => logicalId.includes("RuntimePolicy"));
    // Identical statements per group would add up past a role's inline
    // policy quota.
    expect(runtimePolicies).toHaveLength(1);
    const found = Object.values(
      template.findResources("AWS::Lambda::WebFunctionRevision"),
    );
    expect(found).toHaveLength(2);
    for (const revision of found) {
      expect(revision.DependsOn).toEqual(
        expect.arrayContaining(runtimePolicies),
      );
    }
  });

  it("grants a role that takes no policy updates on the resources", () => {
    const stack = new Stack(new App(), "Stack", { env });
    const role = new Role(stack, "OwnRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    }).withoutPolicyUpdates({ addGrantsToResources: true });
    new NextjsGlobalWebFunctions(stack, "App", {
      buildDirectory: buildDir,
      overrides: { nextjsWebFunctions: { webFunctionProps: { role } } },
    });
    const template = Template.fromStack(stack);
    // Nothing to wait on, so no policy of its own...
    expect(
      Object.keys(template.findResources("AWS::IAM::Policy")).filter(
        (logicalId) => logicalId.includes("RuntimePolicy"),
      ),
    ).toEqual([]);
    // ...but the cache bucket and the revalidation table still let it in.
    const cachePolicy = Object.values(
      template.findResources("AWS::S3::BucketPolicy"),
    ).find((policy) =>
      JSON.stringify(policy.Properties.Bucket).includes("NextjsCache"),
    );
    expect(JSON.stringify(cachePolicy?.Properties.PolicyDocument)).toContain(
      "OwnRole",
    );
    const tables = Object.values(
      template.findResources("AWS::DynamoDB::GlobalTable"),
    );
    expect(tables).toHaveLength(1);
    expect(
      JSON.stringify(
        tables[0].Properties.Replicas.map((it: any) => it.ResourcePolicy),
      ),
    ).toContain("OwnRole");
  });

  it("refuses a distribution from another stack", () => {
    const app = new App();
    const other = new Stack(app, "Other", { env });
    const distribution = new Distribution(other, "Distribution", {
      defaultBehavior: {
        origin: new HttpOrigin("example.com"),
      },
    });
    const stack = new Stack(app, "Stack", { env });
    expect(
      () =>
        new NextjsGlobalWebFunctions(stack, "App", {
          buildDirectory: buildDir,
          distribution,
        }),
    ).toThrow(/`distribution` must be in its stack/);
  });

  it("stages Arm64 binaries whatever this machine is", () => {
    const { app } = synth();
    expect(app.nextjsBuild.architecture).toBe(Architecture.ARM_64);
  });

  describe("Regions", () => {
    it("fails at synth in a Region without Web Functions", () => {
      const stack = new Stack(new App(), "Stack", {
        env: { region: "eu-central-1" },
      });
      expect(
        () =>
          new NextjsGlobalWebFunctions(stack, "App", {
            buildDirectory: buildDir,
          }),
      ).toThrow(/can't deploy to eu-central-1/);
    });

    it("warns when the Region isn't known at synth", () => {
      const stack = new Stack(new App(), "Stack");
      new NextjsGlobalWebFunctions(stack, "App", { buildDirectory: buildDir });
      Annotations.fromStack(stack).hasWarning(
        "*",
        Match.stringLikeRegexp("this stack's Region isn't known at synth"),
      );
    });
  });

  describe("overrides", () => {
    it("refuses an endpoint CloudFront can't sign for", () => {
      expect(() =>
        synth({
          overrides: {
            nextjsWebFunctions: {
              webFunctionProps: {
                defaultEndpointAuth: WebFunctionAuthType.APPLICATION_MANAGED,
              },
            },
          },
        }),
      ).toThrow(/only supports IamAuth/);
      expect(() =>
        synth({
          functionGroups: [
            {
              ...functionGroups[0],
              overrides: {
                webFunctionProps: {
                  defaultEndpointAuth: WebFunctionAuthType.APPLICATION_MANAGED,
                },
              },
            },
          ],
        }),
      ).toThrow(/function group "reports"/);
      expect(() =>
        synth({
          overrides: {
            nextjsWebFunctions: {
              webFunctionProps: {
                defaultEndpoint: {
                  endpointLocation: WebFunctionEndpointLocation.multiRegion([
                    "us-west-2",
                  ]),
                },
              },
            },
          },
        }),
      ).toThrow(/only supports homeRegion\(\)/);
    });

    it("applies shared props to every group, and naming props to the default one", () => {
      const { template } = synth({
        functionGroups,
        overrides: {
          nextjsWebFunctions: {
            webFunctionProps: {
              webFunctionName: "my-app",
              maxConcurrencyPerEnvironment: 32,
              defaultEndpoint: { endpointName: "live" },
              environment: { FOO: "bar" },
            },
          },
        },
      });
      const names = Object.values(
        template.findResources("AWS::Lambda::WebFunction"),
      ).map((fn) => fn.Properties.FunctionName);
      expect(names).toContain("my-app");
      expect(names.filter((name) => name === "my-app")).toHaveLength(1);
      for (const revision of Object.values(revisions(template))) {
        expect(revision.ServiceConfig.EnvironmentVariables).toMatchObject({
          FOO: "bar",
          // Follows a renamed endpoint, or nothing would be trusted.
          CDK_NEXTJS_TRUSTED_ENDPOINT_NAME: "live",
        });
      }
      const endpoints = Object.values(
        template.findResources("AWS::Lambda::WebFunctionEndpoint"),
      );
      expect(endpoints.map((it) => it.Properties.EndpointName)).toEqual([
        "live",
        "live",
      ]);
    });

    // The guard Global Functions has: replacing the viewer-request function
    // would let a viewer's own `X-Forwarded-Host` through to a runtime that
    // trusts it.
    it("refuses a VIEWER_REQUEST association that would replace cdk-nextjs's", () => {
      const stack = new Stack(new App(), "Stack", { env });
      const fn = new CloudFrontFunction(stack, "Mine", {
        code: FunctionCode.fromInline(
          "function handler(e) { return e.request; }",
        ),
      });
      expect(
        () =>
          new NextjsGlobalWebFunctions(stack, "App", {
            buildDirectory: buildDir,
            overrides: {
              nextjsDistribution: {
                dynamicBehaviorOptions: {
                  functionAssociations: [
                    {
                      eventType: FunctionEventType.VIEWER_REQUEST,
                      function: fn,
                    },
                  ],
                },
              },
            },
          }),
      ).toThrow(/NextjsGlobalWebFunctions needs that event type/);
    });
  });

  it("reaches a VPC through one network connector for every group", () => {
    const stack = new Stack(new App(), "Stack", { env });
    new NextjsGlobalWebFunctions(stack, "App", {
      buildDirectory: buildDir,
      functionGroups,
      vpc: new Vpc(stack, "Vpc"),
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::Lambda::NetworkConnector", 1);
    for (const revision of Object.values(revisions(template))) {
      expect(JSON.stringify(revision)).toContain("NetworkConnector");
    }
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

  it("routes each group's patterns, parent and data URLs to its function", () => {
    const stack = new Stack(new App(), "Stack");
    new NextjsRegionalFunctions(stack, "App", {
      buildDirectory: buildDir,
      functionGroups: useDocsGroup(),
    });
    const template = Template.fromStack(stack);
    const apiResources = template.findResources("AWS::ApiGateway::Resource");
    const pathOf = (ref: any): string => {
      const resource = ref?.Ref && apiResources[ref.Ref];
      return resource
        ? `${pathOf(resource.Properties.ParentId)}/${resource.Properties.PathPart}`
        : "";
    };
    const routed = Object.fromEntries(
      Object.values(template.findResources("AWS::ApiGateway::Method"))
        .filter((method) => method.Properties.HttpMethod === "ANY")
        .map((method) => [
          pathOf(method.Properties.ResourceId) || "/",
          groupIn(template, method.Properties.Integration),
        ]),
    );
    expect(routed).toEqual({
      "/": "default",
      "/{proxy+}": "default",
      "/docs/{proxy+}": "docs",
      // The optional catch-all's parent, in both URL spaces.
      "/docs": "docs",
      "/_next/data/{buildId}/docs.json": "docs",
      "/_next/data/{buildId}/docs/{proxy+}": "docs",
      // Parents created only for the data routes, which the default function
      // answers as the catch-all would.
      "/_next/data": "default",
      "/_next/data/{buildId}": "default",
      "/_next/data/{buildId}/docs": "default",
    });
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
  it("forwards CloudFront's headers to the ALB, for the viewer's protocol", () => {
    // Without a certificate CloudFront reaches the ALB over HTTP, so only
    // `CloudFront-Forwarded-Proto` tells the runtime the viewer used HTTPS.
    const stack = new Stack(new App(), "Stack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    new NextjsGlobalContainers(stack, "App", {
      buildDirectory: buildDir,
      healthCheckPath: "/api/health",
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultCacheBehavior: Match.objectLike({
          // Managed-AllViewerAndCloudFrontHeaders-2022-06
          OriginRequestPolicyId: "33f36d7e-f396-46d9-90e0-52428a34d9dc",
        }),
      }),
    });
    // And only this construct tells the shell to trust it.
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            { Name: "CDK_NEXTJS_TRUST_CLOUDFRONT_PROTO", Value: "1" },
          ]),
        }),
      ]),
    });
  });

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

  it("leaves invalidation off when invalidateCdnOnRevalidate is false", () => {
    const stack = new Stack(new App(), "Stack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    new NextjsGlobalContainers(stack, "App", {
      buildDirectory: buildDir,
      healthCheckPath: "/api/health",
      invalidateCdnOnRevalidate: false,
    });
    const template = Template.fromStack(stack);
    const [taskDefinition] = Object.values(
      template.findResources("AWS::ECS::TaskDefinition"),
    );
    for (const container of taskDefinition.Properties.ContainerDefinitions) {
      expect(
        (container.Environment ?? []).map((env: any) => env.Name),
      ).not.toContain("CDK_NEXTJS_DISTRIBUTION_ID");
    }
    const actions = taskRoleActions(template);
    expect(actions).not.toContain("cloudfront:CreateInvalidation");
    expectCacheActions(actions);
    // The invalidation after each deploy is not affected.
    template.resourceCountIs("Custom::NextjsPostDeploy", 1);
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
    // Its ALB is public, so a client can send `CloudFront-Forwarded-Proto`.
    const [taskDefinition] = Object.values(
      template.findResources("AWS::ECS::TaskDefinition"),
    );
    expect(JSON.stringify(taskDefinition)).not.toContain(
      "CDK_NEXTJS_TRUST_CLOUDFRONT_PROTO",
    );
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

describe.each([
  ["NextjsGlobalContainers", NextjsGlobalContainers],
  ["NextjsRegionalContainers", NextjsRegionalContainers],
])("%s", (_, RootConstruct) => {
  it("waits for the ECS service before post-deploy pruning", () => {
    const stack = new Stack(new App(), "Stack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    new RootConstruct(stack, "App", {
      buildDirectory: buildDir,
      healthCheckPath: "/api/health",
    });
    const template = Template.fromStack(stack);
    const services = Object.keys(template.findResources("AWS::ECS::Service"));
    expect(services).toHaveLength(1);
    template.resourceCountIs("Custom::NextjsPostDeploy", 1);
    const [postDeploy] = Object.values(
      template.findResources("Custom::NextjsPostDeploy"),
    );

    // The service, not just its task definition: old tasks can still serve
    // requests after CloudFormation has updated the task definition.
    expect(postDeploy.DependsOn).toEqual(expect.arrayContaining(services));
  });

  // An unset `vpc` prop used to be written over the override's as `undefined`,
  // so the cluster created a VPC of its own and the tasks ran outside the
  // consumer's.
  it("keeps a VPC passed through overrides.nextjsContainers.ecsClusterProps", () => {
    const stack = new Stack(new App(), "Stack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    const vpc = new Vpc(stack, "Vpc");
    const app = new RootConstruct(stack, "App", {
      buildDirectory: buildDir,
      healthCheckPath: "/api/health",
      overrides: { nextjsContainers: { ecsClusterProps: { vpc } } },
    });
    expect(app.nextjsContainers.ecsCluster.vpc).toBe(vpc);
    Template.fromStack(stack).resourceCountIs("AWS::EC2::VPC", 1);
  });
});

describe("static assets read grant", () => {
  /** The static assets bucket objects `s3:GetObject*` reaches, per role. */
  function staticReadObjects(template: Template, roleId: string): string[] {
    return statementsOfRole(template, roleId)
      .filter((statement) =>
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

describe("REST API stage redeploy", () => {
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

describe("deploy-time invalidation", () => {
  it.each([
    ["NextjsGlobalFunctions", NextjsGlobalFunctions],
    ["NextjsGlobalContainers", NextjsGlobalContainers],
  ] as const)("%s scopes it to the app's basePath", (_, Root) => {
    nextConfigBasePath = "base";
    const stack = new Stack(new App(), "Stack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    // A variable, so Functions takes the Containers-only prop without complaint.
    const props = { buildDirectory: buildDir, healthCheckPath: "/api/health" };
    new Root(stack, "App", props);
    const template = Template.fromStack(stack);
    const [resource] = Object.values(
      template.findResources("Custom::NextjsPostDeploy"),
    );
    // `/*` would flush every other app on a shared distribution too.
    expect(
      resource.Properties.createInvalidationCommandInput.invalidationBatch.paths
        .items,
    ).toEqual(["/base", "/base?*", "/base/*"]);
    // The post-deploy prune can't reach another app sharing the bucket.
    const [assetsBucket] = Object.keys(
      template.findResources("AWS::S3::Bucket"),
    ).filter((id) => id.includes("NextjsStaticAssets"));
    const grants = Object.entries(template.findResources("AWS::IAM::Policy"))
      .filter(([id]) => id.includes("NextjsPostDeployFn"))
      .flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement)
      .filter((statement: any) =>
        JSON.stringify(statement.Resource).includes(assetsBucket),
      );
    expect(grants).toHaveLength(1);
    expect(JSON.stringify(grants[0].Resource)).toContain('"/base/*"');
    expect(JSON.stringify(grants[0].Resource)).not.toContain('"/*"');
  });

  // Invalidating before the uploads finish re-caches the old files, and
  // pruning before them can delete an object about to be re-tagged.
  it("runs after every static asset upload", () => {
    const stack = new Stack(new App(), "Stack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    new NextjsGlobalFunctions(stack, "App", { buildDirectory: buildDir });
    const template = Template.fromStack(stack);
    const [postDeploy] = Object.values(
      template.findResources("Custom::NextjsPostDeploy"),
    );
    const uploads = Object.keys(
      template.findResources("Custom::CDKBucketDeployment"),
    ).filter((id) => id.includes("NextjsStaticAssets"));

    expect(uploads).toHaveLength(2);
    expect(postDeploy.DependsOn).toEqual(expect.arrayContaining(uploads));
  });
});

// cdklabs/cdk-nextjs#343: the seed is written once and never over an
// existing key, so a request the new build served before seeding would render
// on demand and that render would win over the prerendered seed.
describe("init cache seeding", () => {
  const initCacheDir = () => join(buildDir, ".next", "cdk-nextjs-init-cache");

  beforeAll(() => {
    write(join(initCacheDir(), "server", "app", "index.html"), "<p/>");
  });

  afterAll(() => {
    rmSync(initCacheDir(), { recursive: true, force: true });
  });

  function synth(construct: (stack: Stack) => void) {
    const stack = new Stack(new App(), "Stack", {
      env: { account: "123456789012", region: "us-east-1" },
    });
    construct(stack);
    const template = Template.fromStack(stack);
    // Its type is the static assets' `BucketDeployment`s' too.
    const seeds = Object.keys(
      template.findResources("Custom::CDKBucketDeployment"),
    ).filter((id) => id.includes("NextjsCacheCacheSeed"));
    expect(seeds).toHaveLength(1);
    return { template, seed: seeds[0] };
  }

  function expectWaitsForSeed(template: Template, type: string, seed: string) {
    const dependents = Object.values(template.findResources(type));
    expect(dependents.length).toBeGreaterThan(0);
    for (const dependent of dependents) {
      expect(dependent.DependsOn).toEqual(expect.arrayContaining([seed]));
    }
  }

  it.each([
    ["NextjsGlobalFunctions", NextjsGlobalFunctions],
    ["NextjsRegionalFunctions", NextjsRegionalFunctions],
  ])("%s: every function group waits for the seed", (_, RootConstruct) => {
    const { template, seed } = synth(
      (stack) =>
        new RootConstruct(stack, "App", {
          buildDirectory: buildDir,
          functionGroups,
        }),
    );
    const groups = appFunctions(template);
    expect(Object.keys(groups).sort()).toEqual(["default", "reports"]);
    const functions = template.findResources("AWS::Lambda::Function");
    for (const logicalId of Object.values(groups)) {
      expect(functions[logicalId].DependsOn).toEqual(
        expect.arrayContaining([seed]),
      );
    }
    expectWaitsForSeed(template, "Custom::NextjsPostDeploy", seed);
  });

  it("NextjsGlobalWebFunctions: every function group waits for the seed", () => {
    const { template, seed } = synth(
      (stack) =>
        new NextjsGlobalWebFunctions(stack, "App", {
          buildDirectory: buildDir,
          functionGroups,
        }),
    );
    template.resourceCountIs("AWS::Lambda::WebFunction", 2);
    expectWaitsForSeed(template, "AWS::Lambda::WebFunction", seed);
    expectWaitsForSeed(template, "Custom::NextjsPostDeploy", seed);
  });

  it.each([
    ["NextjsGlobalContainers", NextjsGlobalContainers],
    ["NextjsRegionalContainers", NextjsRegionalContainers],
  ])("%s: the ECS service waits for the seed", (_, RootConstruct) => {
    const { template, seed } = synth(
      (stack) =>
        new RootConstruct(stack, "App", {
          buildDirectory: buildDir,
          healthCheckPath: "/api/health",
        }),
    );
    expectWaitsForSeed(template, "AWS::ECS::Service", seed);
    expectWaitsForSeed(template, "Custom::NextjsPostDeploy", seed);
  });
});

describe("service workers", () => {
  const swDir = () => join(buildDir, ".next", "static", "service-worker");
  beforeEach(() => write(join(swDir(), "sw.js"), "// sw"));
  afterEach(() => rmSync(swDir(), { recursive: true, force: true }));

  const newStack = () =>
    new Stack(new App(), "Stack", {
      env: { account: "123456789012", region: "us-east-1" },
    });

  it.each([
    ["NextjsGlobalFunctions", NextjsGlobalFunctions],
    ["NextjsGlobalContainers", NextjsGlobalContainers],
  ] as const)(
    "%s sends Service-Worker-Allowed with the app's basePath",
    (_, Root) => {
      nextConfigBasePath = "base";
      const stack = newStack();
      // A variable, so Functions takes the Containers-only prop without complaint.
      const props = {
        buildDirectory: buildDir,
        healthCheckPath: "/api/health",
      };
      new Root(stack, "App", props);
      const template = Template.fromStack(stack);
      template.hasResourceProperties("AWS::CloudFront::Distribution", {
        DistributionConfig: {
          CacheBehaviors: Match.arrayWith([
            Match.objectLike({
              PathPattern: "/base/_next/static/service-worker/*",
            }),
          ]),
        },
      });
      template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
        ResponseHeadersPolicyConfig: {
          CustomHeadersConfig: {
            Items: [
              {
                Header: "Service-Worker-Allowed",
                Value: "/base",
                Override: true,
              },
            ],
          },
        },
      });
    },
  );

  it("NextjsRegionalFunctions uses the app's basePath, not the stage-stripped one", () => {
    // Mounted at the root of the "v1" stage, but the browser sees `/v1/...`.
    nextConfigBasePath = "v1";
    const stack = newStack();
    new NextjsRegionalFunctions(stack, "App", {
      buildDirectory: buildDir,
      overrides: {
        nextjsApi: {
          restApiProps: { deployOptions: { stageName: "v1" } },
        },
      },
    });
    Template.fromStack(stack).hasResourceProperties("AWS::ApiGateway::Method", {
      Integration: {
        IntegrationResponses: Match.arrayWith([
          Match.objectLike({
            StatusCode: "200",
            ResponseParameters: Match.objectLike({
              "method.response.header.Service-Worker-Allowed": "'/v1'",
            }),
          }),
        ]),
      },
    });
  });

  it("adds nothing without a service worker", () => {
    rmSync(swDir(), { recursive: true, force: true });
    const stack = newStack();
    new NextjsGlobalFunctions(stack, "App", { buildDirectory: buildDir });
    expect(JSON.stringify(Template.fromStack(stack).toJSON())).not.toContain(
      "Service-Worker-Allowed",
    );
  });
});
