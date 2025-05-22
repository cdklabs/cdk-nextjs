import { execSync } from "node:child_process";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { join as joinPosix } from "node:path/posix";
import { IgnoreMode } from "aws-cdk-lib";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import { AssetImageCodeProps, DockerImageCode } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import {
  BUILDER_IMAGE_ALIAS_ARG_NAME,
  MOUNT_PATH,
  IMAGE_CACHE_PATH,
  IMAGE_CACHE_PATH_ARG_NAME,
  MOUNT_PATH_ARG_NAME,
  NextjsType,
  PUBLIC_PATH,
  PUBLIC_PATH_ARG_NAME,
  RELATIVE_PATH_TO_WORKSPACE_ARG_NAME,
  SERVER_DIST_PATH,
  SERVER_DIST_PATH_ARG_NAME,
  BUILD_ID_ARG_NAME,
  CACHE_PATH_ARG_NAME,
  CACHE_PATH,
} from "../common";
import { OptionalDockerImageAssetProps } from "../generated-structs/OptionalDockerImageAssetProps";
import { NextjsBaseProps } from "../root-constructs/nextjs-base-props";

export interface BuilderImageProps {
  /**
   * Build Args to be passed to `docker build` command.
   */
  readonly buildArgs?: Record<string, string>;
  /**
   * `docker build ...` command to run in {@link NextBaseProps.buildContext}.
   * Default interpolates other props. If you override, other props will have
   * no effect on command.
   */
  readonly command?: string;
  /**
   * Environment variables names to pass from host to container during build process.
   *
   * Note, a shell script, cdk-nextjs-load-env-vars.sh is created within the
   * {@link NextBaseProps.buildContext} directory, which will contain all the
   * environment variables defined in this prop. If you've created your own
   * custom Dockerfile (passed in via {@link BuilderImageProps.customDockerfilePath})
   * then you need to make sure you're copying it into the image.
   *
   * @example ["MY_API_KEY"]
   */
  readonly envVarNames?: string[];
  /**
   * Lines in .dockerignore file which will be created in your {@link NextBaseProps.buildContext}
   * @default ["node_modules", ".git", ".gitignore", ".md"]
   */
  readonly exclude?: string[];
  /**
   * Name of Dockerfile in builder build context. If specified, you are responsible
   * for ensuring it exists in build context before construct is instantiated.
   * @default "builder.Dockerfile"
   */
  readonly file?: string;
  readonly platform?: Platform;
  /**
   * Skip building the builder image.
   * @default false
   */
  readonly skipBuild?: boolean;
}

export interface NextjsBuildOverrides {
  readonly nextjsContainersDockerImageAssetProps?: OptionalDockerImageAssetProps;
  readonly nextjsFunctionsAssetImageCodeProps?: AssetImageCodeProps;
  readonly nextjsAssetDeploymentAssetImageCodeProps?: AssetImageCodeProps;
  /**
   * Default folder for build context is the "lib/nextjs-build" folder in the
   * installed cdk-nextjs library which has the "global-functions.Dockerfile".
   * Note, if you specify this then you're responsible for ensuring the dockerfile
   * is present in the build context directory and any referenced files are
   * present as well. You can specify dockerfile name with adjacent
   * `nextjsFunctionsAssetImageCodeProps.file` property.
   * @default "cdk-nextjs/lib/nextjs-build"
   */
  readonly functionsImageBuildContext?: string;
  /**
   * Default folder for build context is the "lib/nextjs-build" folder in the
   * installed cdk-nextjs library which has the "assets-deployment.Dockerfile".
   * Note, if you specify this then you're responsible for ensuring the dockerfile
   * is present in the build context directory and any referenced files are
   * present as well. You can specify dockerfile name with adjacent
   * `nextjsAssetDeploymentAssetImageCodeProps.file` property.
   * @default "cdk-nextjs/lib/nextjs-build"
   */
  readonly assetsDeploymentImageBuildContext?: string;
  /**
   * Default folder for build context is the "assets/lambdas/assets-deployment/assets-deployment.lambda" folder in the
   * installed cdk-nextjs library which has the "{...}-containers.Dockerfile".
   * Note, if you specify this then you're responsible for ensuring the dockerfile
   * is present in the build context directory and any referenced files are
   * present as well. You can specify dockerfile name with adjacent
   * `nextjsContainersDockerImageAssetProps.file` property.
   * @default "cdk-nextjs/lib/nextjs-build"
   */
  readonly containersImageBuildContext?: string;
}

export interface NextjsBuildProps {
  /**
   * @see {@link NextjsBaseProps["buildCommand"]}
   */
  readonly buildCommand: NextjsBaseProps["buildCommand"];
  /**
   * @see {@link NextjsBaseProps["buildContext"]}
   */
  readonly buildContext: NextjsBaseProps["buildContext"];
  /**
   *
   */
  readonly builderImageProps?: BuilderImageProps;
  /**
   * @see {@link NextjsBaseProps.relativePathToWorkspace}
   */
  readonly relativePathToWorkspace?: NextjsBaseProps["relativePathToWorkspace"];
  readonly nextjsType: NextjsType;
  readonly overrides?: NextjsBuildOverrides;
}

export interface PublicDirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

/**
 * Builds Next.js assets.
 * @link https://nextjs.org/docs/pages/api-reference/next-config-js/output
 */
export class NextjsBuild extends Construct {
  /**
   * Image alias of builder image Next.js app which is built for other images to be
   * built `FROM`. This image isn't built with CDK Assets construct b/c it
   * doesn't need to be uploaded to ECR. We still need to include slice of
   * `node.addr` in tag in case multiple cdk-nextjs constructs are used.
   */
  builderImageAlias: string;
  /**
   * Unique id for Next.js build. Used to partition EFS FileSystem.
   */
  buildId: string;
  /**
   * Hash of builder image which will change whenever the image changes. Useful
   * for passing to properties of custom resources that depend upon the builder
   * image to re-run when build image changes.
   */
  buildImageDigest: string;
  /**
   * Docker image built if using Fargate.
   */
  imageForNextjsContainers?: DockerImageAsset;
  /**
   * Docker image built if using Lambda.
   */
  imageForNextjsFunctions?: DockerImageCode;
  /**
   * Docker image built for `NextjsAssetsDeployment`
   */
  imageForNextjsAssetsDeployment: DockerImageCode;
  /**
   * Absolute path to public. Use by CloudFront/ALB to create behaviors/rules
   * @example "/Users/john/myapp/public"
   */
  publicDirEntries: PublicDirEntry[];
  /**
   * The entrypoint JavaScript file used as an argument for Node.js to run the
   * Next.js standalone server relative to the standalone directory.
   * @example "./server.js"
   * @example "./packages/ui/server.js" (monorepo)
   */
  relativePathToEntrypoint: string;

  /**
   * Repository name for the builder image.
   */
  private builderImageRepo = "cdk-nextjs/builder";

  private containerRuntime = process.env.CDK_DOCKER || "docker";
  private props: NextjsBuildProps;
  private relativePathToWorkspace: string;

  constructor(scope: Construct, id: string, props: NextjsBuildProps) {
    super(scope, id);
    this.builderImageAlias = `${this.builderImageRepo}:${this.node.addr.slice(30)}`;
    this.relativePathToWorkspace = props.relativePathToWorkspace || ".";
    this.props = props;
    this.relativePathToEntrypoint = this.getRelativeEntrypointPath();
    if (!props.builderImageProps?.skipBuild) {
      this.createBuilderImage();
    }
    this.buildImageDigest = this.getBuilderImageDigest();
    this.buildId = this.getBuildId();
    this.publicDirEntries = this.getPublicDirEntries();
    if (
      props.nextjsType === NextjsType.GLOBAL_CONTAINERS ||
      props.nextjsType === NextjsType.REGIONAL_CONTAINERS
    ) {
      this.imageForNextjsContainers = this.createImageForNextjsContainers();
    } else {
      this.imageForNextjsFunctions = this.createImageForNextjsFunctions();
    }
    this.imageForNextjsAssetsDeployment =
      this.createImageForNextjsAssetsDeployment();
  }

  private getRelativeEntrypointPath() {
    // joinPosix b/c this will be used in linux container
    return joinPosix(this.props.relativePathToWorkspace || "", "server.js");
  }
  /**
   * A builder or base image needs to be created so that the same image can be
   * built `FROM` for `NextjsFunctions` or `NextjsContainers` and `NextjsAssetsDeployment`.
   * This image doesn't need to be uploaded to ECR so we're "manually" creating
   * it with `execSync` and other images will be built `FROM` it.
   */
  private createBuilderImage() {
    const buildCommand = this.props.buildCommand || "npm run build";
    const {
      buildArgs = {
        BUILD_COMMAND: buildCommand,
        RELATIVE_PATH_TO_WORKSPACE: this.relativePathToWorkspace,
        ...this.props.builderImageProps?.buildArgs,
      },
      envVarNames = [],
      exclude = [
        "**/node_modules",
        ".git",
        "**/cdk.out",
        "**/.next",
        ".gitignore",
        "*.md",
      ],
      file = "builder.Dockerfile",
      platform,
    } = this.props.builderImageProps || {};

    const filePathsToCopy: string[] = [
      // although cache-handler is only needed in runtime image, we copy into
      // builder for convenience so that if lib consumer customizes runtime image
      // then they can copy from builder image instead of having to copy from
      // lib in node_modules.
      join(__dirname, "add-cache-handler.mjs"),
      join(__dirname, "cache-handler.cjs"),
    ];

    if (!this.props.builderImageProps?.file) {
      // if file is not specified by user, then we need to copy our builder.Dockerfile
      // into builder build context.
      filePathsToCopy.push(join(__dirname, file));
    }

    filePathsToCopy.forEach((filePathToCopy) => {
      cpSync(
        filePathToCopy,
        join(this.props.buildContext, basename(filePathToCopy)),
      );
    });

    const excludeFileStr = exclude?.join("\n");
    const dockerignoreFilePath = join(this.props.buildContext, ".dockerignore");
    writeFileSync(dockerignoreFilePath, excludeFileStr);
    const buildArgsStr = this.createBuildArgStr(buildArgs);
    const loadEnvVarsScriptPath = join(
      this.props.buildContext,
      "cdk-nextjs-load-env-vars.sh",
    );
    this.createLoadEnvVarsScript(envVarNames, loadEnvVarsScriptPath);
    const command =
      this.props.builderImageProps?.command ||
      `${this.containerRuntime} build ${platform ? `--platform ${platform.platform}` : ""} --file ${file} --tag ${this.builderImageAlias} ${buildArgsStr} .`;
    let error: unknown;
    try {
      console.log(
        `Building image with command: ${command} in directory: ${this.props.buildContext}`,
      );
      execSync(command, {
        stdio: "inherit",
        cwd: this.props.buildContext,
        env: process.env,
      });
    } catch (err) {
      error = err;
    } finally {
      filePathsToCopy.forEach((filePathToCopy) => {
        rmSync(join(this.props.buildContext, basename(filePathToCopy)));
      });
      rmSync(dockerignoreFilePath);
      rmSync(loadEnvVarsScriptPath);
    }
    if (error) throw error;
  }
  private createBuildArgStr(
    buildArgs: Required<BuilderImageProps>["buildArgs"],
  ) {
    return Object.entries(buildArgs).reduce((acc, [key, value]) => {
      return `${acc} --build-arg ${key}="${value}"`;
    }, "");
  }
  private createLoadEnvVarsScript(
    envVarNames: Required<BuilderImageProps>["envVarNames"] = [],
    loadEnvVarsScriptPath: string,
  ) {
    let loadEnvVarsScript =
      "# Dynamically generated script to load env vars into build container";
    for (const envVarName of envVarNames) {
      loadEnvVarsScript += `\nexport ${envVarName}=${process.env[envVarName] || '""'}`;
    }
    writeFileSync(loadEnvVarsScriptPath, loadEnvVarsScript);
  }
  private getBuilderImageDigest() {
    const digest = execSync(
      `${this.containerRuntime} images --no-trunc --quiet ${this.builderImageAlias}`,
      { encoding: "utf-8" },
    );
    return digest.slice(0, -1); // remove trailing \n
  }
  private getPublicDirEntries(): PublicDirEntry[] {
    const publicDirPath = joinPosix(
      "/app",
      this.props.relativePathToWorkspace || "",
      "public",
    );
    const publicDirEntriesString = execSync(
      `${this.containerRuntime} run ${this.builderImageAlias} node -e "console.log(JSON.stringify(fs.readdirSync('${publicDirPath}', { withFileTypes: true }).map((e) => ({ name: e.name, isDirectory: e.isDirectory()}))))"`,
      { encoding: "utf-8" },
    );
    return JSON.parse(publicDirEntriesString) as PublicDirEntry[];
  }
  private getBuildId() {
    const buildIdPath = joinPosix(
      "/app",
      this.props.relativePathToWorkspace || "",
      ".next",
      "BUILD_ID",
    );
    const buildId = execSync(
      `${this.containerRuntime} run ${this.builderImageAlias} /bin/sh -c "cat ${buildIdPath}"`,
      { encoding: "utf-8" },
    );
    return buildId;
  }
  private createImageForNextjsContainers() {
    const dockerfileNamePrefix =
      this.props.nextjsType === NextjsType.GLOBAL_CONTAINERS
        ? "global"
        : "regional";
    const dockerfileName = `${dockerfileNamePrefix}-containers.Dockerfile`;
    // cdk-nextjs/builder-{hash} already contains built nextjs app which we'll
    // `COPY --from=cdk-nextjs/builder-{hash}` so we just need the Dockerfile
    // which is in lib/nextjs-build folder.
    const buildContext =
      this.props.overrides?.containersImageBuildContext ??
      join(__dirname, "..", "..", "lib", "nextjs-build");
    const dockerImageAsset = new DockerImageAsset(this, "Image", {
      directory: buildContext,
      extraHash: this.buildImageDigest, // rebuild when builder hash changes
      file: dockerfileName,
      ignoreMode: IgnoreMode.DOCKER,
      ...this.props.overrides?.nextjsContainersDockerImageAssetProps,
      buildArgs: {
        [BUILD_ID_ARG_NAME]: this.buildId,
        [BUILDER_IMAGE_ALIAS_ARG_NAME]: this.builderImageAlias,
        [CACHE_PATH_ARG_NAME]: CACHE_PATH,
        [PUBLIC_PATH_ARG_NAME]: PUBLIC_PATH,
        [IMAGE_CACHE_PATH_ARG_NAME]: IMAGE_CACHE_PATH,
        [MOUNT_PATH_ARG_NAME]: MOUNT_PATH,
        [SERVER_DIST_PATH_ARG_NAME]: SERVER_DIST_PATH,
        [RELATIVE_PATH_TO_WORKSPACE_ARG_NAME]: this.relativePathToWorkspace,
        ...this.props.overrides?.nextjsContainersDockerImageAssetProps
          ?.buildArgs,
      },
    });
    return dockerImageAsset;
  }

  private createImageForNextjsFunctions() {
    const dockerfileName = "global-functions.Dockerfile";
    // cdk-nextjs/builder-{hash} already contains built nextjs app which we'll
    // `COPY --from=cdk-nextjs/builder-{hash}` so we just need the Dockerfile
    // which is in lib/nextjs-build folder.
    const buildContext =
      this.props.overrides?.functionsImageBuildContext ??
      join(__dirname, "..", "..", "lib", "nextjs-build");
    const dockerImageCode = DockerImageCode.fromImageAsset(buildContext, {
      cmd: ["node", this.relativePathToEntrypoint],
      extraHash: this.buildImageDigest, // rebuild when builder hash changes
      file: dockerfileName,
      ignoreMode: IgnoreMode.DOCKER,
      ...this.props.overrides?.nextjsFunctionsAssetImageCodeProps,
      buildArgs: {
        [BUILD_ID_ARG_NAME]: this.buildId,
        [BUILDER_IMAGE_ALIAS_ARG_NAME]: this.builderImageAlias,
        [CACHE_PATH_ARG_NAME]: CACHE_PATH,
        [PUBLIC_PATH_ARG_NAME]: PUBLIC_PATH,
        [IMAGE_CACHE_PATH_ARG_NAME]: IMAGE_CACHE_PATH,
        [MOUNT_PATH_ARG_NAME]: MOUNT_PATH,
        [SERVER_DIST_PATH_ARG_NAME]: SERVER_DIST_PATH,
        [RELATIVE_PATH_TO_WORKSPACE_ARG_NAME]: this.relativePathToWorkspace,
        ...this.props.overrides?.nextjsFunctionsAssetImageCodeProps?.buildArgs,
      },
    });
    // TODO: how to clean up temp dir?
    // rmSync(tempDir, { recursive: true });
    return dockerImageCode;
  }

  private createImageForNextjsAssetsDeployment() {
    const dockerfileName = "assets-deployment.Dockerfile";
    /**
     * Path to bundled custom resource code
     */
    const buildContext =
      this.props.overrides?.assetsDeploymentImageBuildContext ??
      join(
        __dirname,
        "..",
        "..",
        "assets",
        "lambdas",
        "assets-deployment",
        "assets-deployment.lambda",
      );
    // cdk-nextjs/builder-{hash} already contains Next.js built code which
    // we'll copy into final image. But we also need lambda code to run
    // asset deployment tasks
    const dockerImageCode = DockerImageCode.fromImageAsset(buildContext, {
      extraHash: this.buildImageDigest, // rebuild when builder hash changes
      file: dockerfileName,
      ignoreMode: IgnoreMode.DOCKER,
      ...this.props.overrides?.nextjsAssetDeploymentAssetImageCodeProps,
      buildArgs: {
        [BUILD_ID_ARG_NAME]: this.buildId,
        [BUILDER_IMAGE_ALIAS_ARG_NAME]: this.builderImageAlias,
        [RELATIVE_PATH_TO_WORKSPACE_ARG_NAME]: this.relativePathToWorkspace,
        ...this.props.overrides?.nextjsAssetDeploymentAssetImageCodeProps
          ?.buildArgs,
      },
    });
    return dockerImageCode;
  }
}
