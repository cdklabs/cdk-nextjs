/* eslint-disable import/no-extraneous-dependencies */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AttributeType, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { Architecture, Code } from "aws-cdk-lib/aws-lambda";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { NextjsFunctions, NextjsFunctionsOverrides } from "./nextjs-functions";
import { NextjsType } from "../constants";

describe("NextjsFunctions overrides", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nextjs-functions-test-"));
    for (const name of ["default", "reports", "other"]) {
      // Distinct content, so each root is a distinct asset hash.
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "index.js"), `// ${name}`);
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Lambda function properties by the group env var each function carries. */
  function synth(
    overrides: NextjsFunctionsOverrides,
    groupOverrides?: NextjsFunctionsOverrides,
    staged: Architecture = Architecture.X86_64,
  ) {
    const stack = new Stack(new App(), "TestStack");
    new NextjsFunctions(stack, "Functions", {
      cacheBucket: new Bucket(stack, "Cache"),
      revalidationTable: new TableV2(stack, "Table", {
        partitionKey: { name: "pk", type: AttributeType.STRING },
      }),
      staticAssetsBucket: new Bucket(stack, "Assets"),
      buildId: "build",
      buildDirectory: dir,
      nextjsType: NextjsType.REGIONAL_FUNCTIONS,
      deploymentRootPath: join(dir, "default"),
      relativeProjectDir: "",
      deploymentRoots: [
        {
          name: "default",
          path: join(dir, "default"),
          routes: [],
          architecture: staged,
        },
        {
          name: "reports",
          path: join(dir, "reports"),
          routes: ["/reports"],
          architecture: staged,
        },
      ],
      functionGroups: [
        { name: "reports", routes: ["/reports"], overrides: groupOverrides },
      ],
      overrides,
    });
    const functions = Template.fromStack(stack).findResources(
      "AWS::Lambda::Function",
    );
    return Object.fromEntries(
      Object.values(functions).map((fn) => [
        fn.Properties.Environment.Variables.CDK_NEXTJS_FUNCTION_GROUP,
        fn.Properties,
      ]),
    );
  }

  it("applies shared props to every group", () => {
    const functions = synth({ functionProps: { memorySize: 3008 } });

    expect(functions.default.MemorySize).toBe(3008);
    expect(functions.reports.MemorySize).toBe(3008);
  });

  it("applies functionName, code and handler to the default group only", () => {
    const functions = synth({
      functionProps: {
        functionName: "my-app",
        code: Code.fromAsset(join(dir, "other")),
        handler: "custom.handler",
      },
    });

    expect(functions.default.FunctionName).toBe("my-app");
    expect(functions.default.Handler).toBe("custom.handler");
    expect(functions.reports.FunctionName).toBeUndefined();
    expect(functions.reports.Handler).toBe("cdk-nextjs-runtime/lambda.handler");
    // Each group still ships its own deployment root.
    expect(functions.reports.Code).not.toEqual(functions.default.Code);
  });

  it("lets a group set its own functionName", () => {
    const functions = synth(
      { functionProps: { functionName: "my-app" } },
      { functionProps: { functionName: "my-app-reports" } },
    );

    expect(functions.default.FunctionName).toBe("my-app");
    expect(functions.reports.FunctionName).toBe("my-app-reports");
  });

  describe("architecture", () => {
    it("deploys what the root was staged for, whatever this machine is", () => {
      expect(synth({}).default.Architectures).toEqual(["x86_64"]);
      const arm = synth({}, undefined, Architecture.ARM_64);
      expect(arm.default.Architectures).toEqual(["arm64"]);
      expect(arm.reports.Architectures).toEqual(["arm64"]);
    });

    it("accepts an override that matches the staged binaries", () => {
      const functions = synth(
        { functionProps: { architecture: Architecture.ARM_64 } },
        undefined,
        Architecture.ARM_64,
      );
      expect(functions.default.Architectures).toEqual(["arm64"]);
    });

    // Silently deploying the staged architecture instead of the one asked for
    // is how this used to fail.
    it("throws on an override the staged binaries can't run on", () => {
      expect(() =>
        synth({ functionProps: { architecture: Architecture.ARM_64 } }),
      ).toThrow(/staged its native dependencies \(sharp\) for x86_64/);
      expect(() =>
        synth({}, { functionProps: { architecture: Architecture.ARM_64 } }),
      ).toThrow(/function group "reports" is arm64/);
    });
  });
});
