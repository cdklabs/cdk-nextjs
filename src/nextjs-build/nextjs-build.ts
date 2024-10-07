import { execSync } from "node:child_process";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { join as joinPosix } from "node:path/posix";
import { IgnoreMode } from "aws-cdk-lib";
import { DockerImageAsset, Platform } from "aws-cdk-lib/aws-ecr-assets";
import { AssetImageCodeProps, DockerImageCode } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import {
  DATA_CACHE_DIR,
  FULL_ROUTE_CACHE_DIR,
  IMAGE_CACHE_DIR,
  NextjsType,
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
   * Name of Dockerfile
   * @default "builder.Dockerfile"
   */
  readonly file?: string;
  readonly platform?: Platform;
  /**
   * Skip building the builder image.
   * @default false
   */
  readonly skipBuild?: boolean;
  /**
   * Path to your custom builder.Dockerfile which will be copied into {@link NextBaseProps.buildContext}.
   * It is recommended to override this prop to optimize build caching for your setup.
   */
  readonly customDockerfilePath?: string;
}

export interface NextjsBuildOverrides {
  readonly nextjsContainersDockerImageAssetProps?: OptionalDockerImageAssetProps;
  readonly nextjsFunctionsAssetImageCodeProps?: AssetImageCodeProps;
  readonly nextjsAssetDeploymentAssetImageCodeProps?: AssetImageCodeProps;
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
   * Hash of builder image which will change whenever the image changes. Useful
   * for passing to properties of custom resources that depend upon the builder
   * image to re-run when build image changes.
   */
  buildImageDigest: string;
  /**
   * Mount path in container for EFS. Next.js image optimization, data, and full
   * route cache will be symlinked to this location.
   *
   * Must comply with pattern: ^/mnt/[a-zA-Z0-9-_.]+$
   * @see https://docs.aws.amazon.com/lambda/latest/api/API_FileSystemConfig.html
   */
  containerMountPathForEfs = "/mnt/cdk-nextjs-cache";
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
   * Tag of builder image Next.js app which is built for other images to be
   * built `FROM`. This image isn't built with CDK Assets construct b/c it
   * doesn't need to be uploaded to ECR. We still need to include slice of
   * `node.addr` in tag in case multiple cdk-nextjs constructs are used.
   */
  private builderImageTag: string;
  private containerRuntime = process.env.CDK_DOCKER || "docker";
  private props: NextjsBuildProps;
  private relativePathToWorkspace: string;

  constructor(scope: Construct, id: string, props: NextjsBuildProps) {
    super(scope, id);
    this.builderImageTag = `cdk-nextjs/builder-${this.node.addr.slice(30)}`;
    this.relativePathToWorkspace = props.relativePathToWorkspace || ".";
    this.props = props;
    this.relativePathToEntrypoint = this.getRelativeEntrypointPath();
    this.buildImageDigest = this.createBuilderImage();
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
      skipBuild = false,
    } = this.props.builderImageProps || {};
    const srcDockerfilePath =
      this.props.builderImageProps?.customDockerfilePath ||
      join(__dirname, file);
    const destDockerfilePath = join(this.props.buildContext, file);
    cpSync(srcDockerfilePath, destDockerfilePath);
    const excludeFileStr = exclude?.join("\n");
    const dockerignoreFilePath = join(this.props.buildContext, ".dockerignore");
    writeFileSync(dockerignoreFilePath, excludeFileStr);
    const buildArgsStr = this.createBuildArgStr(buildArgs);
    const loadEnvVarsScriptPath = join(
      this.props.buildContext,
      "cdk-nextjs-load-env-vars.sh",
    );
    if (envVarNames.length) {
      this.createLoadEnvVarsScript(envVarNames, loadEnvVarsScriptPath);
    }
    const command =
      this.props.builderImageProps?.command ||
      `${this.containerRuntime} build ${platform ? `--platform ${platform.platform}` : ""} --file ${file} --tag ${this.builderImageTag} ${buildArgsStr} .`;
    let error: unknown;
    try {
      if (!skipBuild) {
        console.log(
          `Building image with command: ${command} in directory: ${this.props.buildContext}`,
        );
        execSync(command, {
          stdio: "inherit",
          cwd: this.props.buildContext,
          env: process.env,
        });
      }
    } catch (err) {
      error = err;
    } finally {
      rmSync(destDockerfilePath);
      rmSync(dockerignoreFilePath);
      if (envVarNames.length) {
        rmSync(loadEnvVarsScriptPath);
      }
    }
    if (error) throw error;
    return this.getBuilderImageDigest();
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
      `${this.containerRuntime} images --no-trunc --quiet ${this.builderImageTag}`,
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
      `${this.containerRuntime} run ${this.builderImageTag} node -e "console.log(JSON.stringify(fs.readdirSync('${publicDirPath}', { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory()}))))"`,
      { encoding: "utf-8" },
    );
    return JSON.parse(publicDirEntriesString) as PublicDirEntry[];
  }
  private createImageForNextjsContainers() {
    const dockerfileNamePrefix =
      this.props.nextjsType === NextjsType.GLOBAL_CONTAINERS
        ? "global"
        : "regional";
    const dockerfileName = `${dockerfileNamePrefix}-containers.Dockerfile`;
    // cdk-nextjs/builder-{hash} already contains built nextjs app which we'll
    // `COPY --from=cdk-nextjs/builder-{hash}` so we just need the Dockerfile
    // and symlink-full-route-cache scripts which are in lib/nextjs-build folder.
    const buildContext = join(__dirname, "..", "..", "lib", "nextjs-build");
    const dockerImageAsset = new DockerImageAsset(this, "Image", {
      buildArgs: {
        BUILDER_IMAGE_TAG: this.builderImageTag,
        DATA_CACHE_DIR,
        FULL_ROUTE_CACHE_DIR,
        IMAGE_CACHE_DIR,
        MOUNT_PATH: this.containerMountPathForEfs,
        RELATIVE_PATH_TO_WORKSPACE: this.relativePathToWorkspace,
      },
      directory: buildContext,
      exclude: [
        "*",
        `!${dockerfileName}`,
        "!symlink-full-route-cache.mjs",
        "!add-cache-handler.mjs",
      ],
      extraHash: this.buildImageDigest, // rebuild when builder hash changes
      file: dockerfileName,
      ignoreMode: IgnoreMode.DOCKER,
      ...this.props.overrides?.nextjsContainersDockerImageAssetProps,
    });
    return dockerImageAsset;
  }

  private createImageForNextjsFunctions() {
    const dockerfileName = "global-functions.Dockerfile";
    // cdk-nextjs/builder-{hash} already contains built nextjs app which we'll
    // `COPY --from=cdk-nextjs/builder-{hash}` so we just need the Dockerfile
    // and symlink-full-route-cache scripts which are in lib/nextjs-build folder.
    const buildContext = join(__dirname, "..", "..", "lib", "nextjs-build");
    const dockerImageCode = DockerImageCode.fromImageAsset(buildContext, {
      buildArgs: {
        BUILDER_IMAGE_TAG: this.builderImageTag,
        DATA_CACHE_DIR,
        FULL_ROUTE_CACHE_DIR,
        IMAGE_CACHE_DIR,
        MOUNT_PATH: this.containerMountPathForEfs,
        RELATIVE_PATH_TO_WORKSPACE: this.relativePathToWorkspace,
      },
      cmd: ["node", this.relativePathToEntrypoint],
      exclude: [
        "*",
        `!${dockerfileName}`,
        "!symlink-full-route-cache.mjs",
        "!add-cache-handler.mjs",
        "!cache-handler.cjs",
      ],
      extraHash: this.buildImageDigest, // rebuild when builder hash changes
      file: dockerfileName,
      ignoreMode: IgnoreMode.DOCKER,
      ...this.props.overrides?.nextjsFunctionsAssetImageCodeProps,
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
    const lambdaBuildContext = join(
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
    const dockerImageCode = DockerImageCode.fromImageAsset(lambdaBuildContext, {
      buildArgs: {
        BUILDER_IMAGE_TAG: this.builderImageTag,
        RELATIVE_PATH_TO_WORKSPACE: this.relativePathToWorkspace,
      },
      extraHash: this.buildImageDigest, // rebuild when builder hash changes
      file: dockerfileName,
      ignoreMode: IgnoreMode.DOCKER,
      ...this.props.overrides?.nextjsAssetDeploymentAssetImageCodeProps,
    });
    return dockerImageCode;
  }
}
