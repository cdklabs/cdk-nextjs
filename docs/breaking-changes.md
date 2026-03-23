# Breaking Changes

## 0.5.0

### Architecture Changes

This release introduces a major architectural shift from Docker-based builds to local builds, and from EFS-based caching to S3 + DynamoDB caching. This significantly simplifies the infrastructure and improves deployment speed.

### Automatic Detection of Monorepo Structure

- **`relativePathToPackage`** property has been **removed** from `NextjsBaseProps`
  - This value is now automatically detected from the Next.js standalone build output
  - For monorepo setups, the library searches for `server.js` with a `.next` sibling directory within `.next/standalone/`
  - No user configuration needed - works automatically for both simple apps and monorepos
  - **Migration:** Simply remove the `relativePathToPackage` property from your construct props

### Removed Constructs and Exports

- **`NextjsAssetsDeployment`** - Removed entirely. Assets are now deployed directly during the build process without requiring a separate Custom Resource
  - `NextjsAssetsDeploymentProps` removed
  - `NextjsAssetDeploymentOverrides` removed
  - `StaticAssetsCustomResourceProperties` removed
  - `OptionalNextjsAssetsDeploymentProps` removed

- **`NextjsFileSystem`** - Removed entirely. EFS is no longer used; caching now uses S3 + DynamoDB
  - `NextjsFileSystemProps` removed
  - `NextjsFileSystemOverrides` removed
  - `AllowComputeProps` removed
  - `OptionalNextjsFileSystemProps` removed

- **`NextjsVpc`** - Removed entirely. VPC management simplified
  - `NextjsVpcProps` removed
  - `NextjsVpcOverrides` removed
  - `OptionalNextjsVpcProps` removed
  - SQS VPC Interface Endpoint no longer created
  - VPC can now be provided via `NextjsBaseProps.vpc` (optional)
  - If provided, VPC is passed through overrides to ECS Cluster (containers) or Lambda function
  - If not provided, ECS Cluster creates a VPC automatically for containers
  - Lambda functions run outside VPC by default unless VPC is explicitly provided

### New Constructs and Exports

- **`NextjsCache`** - New construct managing S3 bucket and DynamoDB table for Next.js caching
  - `NextjsCacheProps` - Properties for NextjsCache construct
  - `NextjsCacheOverrides` - Overrides for NextjsCache construct
  - `OptionalNextjsCacheProps` - Optional properties for NextjsCache
  - Provides `cacheBucket` (S3) and `revalidationTable` (DynamoDB) properties

### NextjsBuild Changes

- **Removed properties:**
  - `buildContext` → replaced with `buildDirectory`
  - `builderImageProps` - Docker builder configuration no longer needed
  - `overrides` - Build overrides removed (NextjsBuildOverrides)
  - `builderImageAlias` - No longer builds Docker images
  - `buildImageDigest` - No longer builds Docker images
  - `imageForNextjsContainers` - Docker images removed
  - `imageForNextjsFunctions` - Docker images removed
  - `imageForNextjsAssetsDeployment` - Assets deployment removed

- **New properties:**
  - `buildDirectory` - Absolute path to Next.js app directory for local builds
  - `skipBuild` - Optional boolean to skip running `next build`
  - `initCacheDir` - Absolute path to init cache directory (`.next/cdk-nextjs-init-cache`)
  - `dotNextPath` - Absolute path to `.next` directory

- **Changed behavior:**
  - Builds now run locally using Node.js instead of Docker
  - Sharp binaries are automatically replaced with Linux-compatible versions
  - Build artifacts are read directly from the local `.next` directory

### NextjsBaseProps Changes

- **Property changes:**
  - `buildContext` → `buildDirectory` - Now expects absolute path to Next.js app
  - `relativePathToWorkspace` - Removed (was already deprecated in 0.4.0)
  - `skipBuild` - New optional property to skip build execution
  - `vpc` - New optional property to provide custom VPC for container or function deployments

### NextjsBaseConstructOverrides Changes

- **Removed properties:**
  - `nextjsVpcProps`
  - `nextjsFileSystemProps`
  - `nextjsAssetsDeploymentProps`
  - `nextjsPostDeployProps` (moved to specific construct overrides)

- **New properties:**
  - `nextjsCacheProps` - Overrides for the new NextjsCache construct

### NextjsBaseOverrides Changes

- **Removed properties:**
  - `nextjsBuild` - Build overrides removed (NextjsBuildOverrides type)
  - `nextjsFileSystem` - Construct removed
  - `nextjsVpc` - Moved to compute constructs
  - `nextjsAssetsDeployment` - Construct removed
  - `nextjsPostDeploy` - Moved to specific construct overrides

- **New properties:**
  - `nextjsCache` - Overrides for NextjsCache construct (NextjsCacheOverrides type)

### NextjsBaseConstruct Changes

- **Removed properties:**
  - `nextjsVpc` - No longer created at base level
  - `nextjsFileSystem` - EFS removed
  - `nextjsAssetsDeployment` - Assets deployment removed
  - `nextjsPostDeploy` - Moved to specific constructs

- **New properties:**
  - `nextjsCache` - Instance of NextjsCache construct

### NextjsGlobalFunctions and NextjsRegionalFunctions Changes

- **New properties:**
  - `nextjsPostDeploy` - Now managed by these constructs instead of base construct

- **Override changes:**
  - `NextjsGlobalFunctionsConstructOverrides` now includes `nextjsPostDeployProps`
  - `NextjsGlobalFunctionsOverrides` now includes `nextjsPostDeploy`
  - `NextjsRegionalFunctionsConstructOverrides` now includes `nextjsPostDeployProps`
  - `NextjsRegionalFunctionsOverrides` now includes `nextjsPostDeploy`

- **Behavior changes:**
  - Lambda functions no longer require VPC or EFS mounts
  - Cache operations now use S3 + DynamoDB via SDK calls

### NextjsContainersProps (OptionalNextjsContainersProps) Changes

- **Removed properties:**
  - `fileSystem` - EFS removed
  - `dockerImageAsset` - Containers now use locally built artifacts
  - `accessPoint` - EFS removed
  - `vpc` - VPC is no longer a direct property on NextjsContainersProps

- **New/Required properties:**
  - `cacheBucket` - S3 bucket for cache storage
  - `revalidationTable` - DynamoDB table for revalidation metadata
  - `buildDirectory` - Directory where the Next.js application is located (contains `.next` folder)
  - `relativePathToPackage` - Relative path to package containing Next.js app

- **Behavior changes:**
  - Containers now copy standalone build from local `.next/standalone` directory
  - No longer build from Docker images at deployment time
  - VPC is now provided via `NextjsBaseProps.vpc` or `overrides.nextjsContainers.ecsClusterProps.vpc`
  - If no VPC provided, ECS Cluster will create one automatically

### NextjsPostDeploy Changes

- **New responsibilities:**
  - Prunes old cache entries from S3 bucket (by `buildId`)
  - Prunes old entries from DynamoDB revalidation table (by `buildId`)
  - Still handles CloudFront invalidation
  - Still prunes old S3 static assets

- **Property changes:**
  - Now receives `cacheBucket` instead of `accessPoint`
  - Now receives `revalidationTable`
  - No longer requires VPC

### NextjsStaticAssets Changes

- **New properties:**
  - `buildDirectory` - Directory where the Next.js application is located (contains `.next` folder and static assets)

- **Behavior changes:**
  - Reads static assets directly from local `.next/static` and `public` directories
  - No longer relies on NextjsAssetsDeployment custom resource

### Migration Guide

1. **Update `buildContext` to `buildDirectory`:**

   ```typescript
   // Before
   new NextjsGlobalFunctions(this, "Web", {
     buildContext: join(__dirname, ".."),
   });

   // After
   new NextjsGlobalFunctions(this, "Web", {
     buildDirectory: join(__dirname, ".."),
   });
   ```

2. **Remove Docker-related overrides:**

   ```typescript
   // Remove any references to:
   // - builderImageProps
   // - dockerImageAsset
   // - functionsImageBuildContext
   // - containersImageBuildContext
   // - assetsDeploymentImageBuildContext
   ```

3. **Update custom overrides:**

   ```typescript
   // Before
   overrides: {
     nextjsFileSystem: { /* ... */ },
     nextjsAssetsDeployment: { /* ... */ },
   }

   // After
   overrides: {
     nextjsCache: { /* ... */ },
   }
   ```

4. **Environment setup:**
   - Ensure Node.js and npm/pnpm/yarn are available in your CDK deployment environment
   - Build now runs locally, so your CI/CD pipeline needs Node.js runtime
   - Docker is no longer required for builds

5. **For container deployments:**
   - VPC can now be provided via `NextjsBaseProps.vpc` instead of through overrides
   - Containers now copy from `.next/standalone` instead of building from Docker images
   - If no VPC is provided, ECS Cluster will create one automatically

6. **For function deployments:**
   - VPC can optionally be provided via `NextjsBaseProps.vpc` if Lambda functions need VPC access
   - If no VPC is provided, Lambda functions run outside a VPC (default behavior)

### Benefits of These Changes

- **Faster deployments** - No Docker image `next build`s required
- **Simpler infrastructure** - No EFS, reduced Lambda cold starts
- **Better local development** - Uses standard `next build` workflow
- **Reduced costs** - No EFS costs, simpler Lambda/container setup
- **Official Next.js Adapters** - Follows official Next.js Adapters deployment model

### Public Property Type Changes

Several public properties and props were widened from concrete types to interfaces to support importing existing ("bring your own") resources. If you access concrete-only methods on these properties, you'll need to cast or adjust your code.

| Location                  | Property             | Before                    | After                      |
| ------------------------- | -------------------- | ------------------------- | -------------------------- |
| `NextjsContainers`        | `ecsCluster`         | `Cluster`                 | `ICluster`                 |
| `NextjsCache`             | `revalidationTable`  | `TableV2`                 | `ITable`                   |
| `NextjsStaticAssets`      | `bucket`             | `Bucket`                  | `IBucket`                  |
| `NextjsComputeBaseProps`  | `revalidationTable`  | `TableV2`                 | `ITable`                   |
| `NextjsPostDeployProps`   | `revalidationTable`  | `TableV2`                 | `ITable`                   |
| `NextjsPostDeployProps`   | `staticAssetsBucket` | `Bucket`                  | `IBucket`                  |
| `NextjsDistributionProps` | `loadBalancer`       | `ApplicationLoadBalancer` | `IApplicationLoadBalancer` |

These are widening changes — existing code that only reads standard interface properties (e.g. `bucketName`, `tableName`, `clusterName`) will continue to work. If you call concrete-only methods (e.g. `Cluster.addCapacity()`, `TableV2.replica()`), cast the property:

```typescript
const cluster = nextjs.nextjsContainers.ecsCluster as Cluster;
```

## 0.4.0

- Change `Nextjs{...}Props.relativePathToWorkspace` -> `Nextjs{...}Props.relativePathToPackage` because workspace references entire monorepo not a package in the monorepo.
- [NextjsGlobalFunctions] Remove `NextjsRevalidation`. `NextjsRevalidation` was an initial effor to support ISR. This wasn't working as intended. With [RFC: Deployment Adapters API](https://github.com/vercel/next.js/discussions/77740) specifically addressing the pain point, "No signal for when background work like revalidating is complete", cdk-nextjs will support ISR once the `waitFor` callback is officially supported by Next.js instead of using internal workaround. This is inline with the design principles of cdk-nextjs. Removing this construct simplifies cdk-nextjs and makes it more maintainable long term.
- [NextjsGlobal...] Refactor `NextjsInvalidation` to `NextjsPostDeploy` which now does not use `AwsCustomResource` but is `CustomResource` which calls `CreateInvalidation` API within, in addition to pruning EFS old BUILD_ID folder and old S3 static assets
  - Relevant but not user facing change is that EFS Mounts are now segmented by BUILD_ID and S3 objects are now tagged with "next-build-id" metadata which are a step towards Blue/Green deployments.
- Change BUILDER_IMAGE_TAG to BUILDER_IMAGE_ALIAS in `NextjsBuild` and Dockerfiles. This change is mostly internal and will only affect you if you used overrides. Reason for change was to resolve Docker warning, `InvalidDefaultArgInFrom`, and to improve semantics. A tag in Dockerfile reference is what comes after the :. Alias is repo:tag. Now repository (cdk-nextjs/builder) and tag (CDK's `node.addr.slice(30)`) so we can properly default to `cdk-nextjs/builder:latest` in Dockerfiles.
- Remove `overrides.{nextjs...}.nextjsBuildProps.customDockerfilePath` in favor of `buildContext` + `overrides.{nextjs...}.nextjsBuildProps.file`. Simplies from 2 ways to 1. Default builder image Dockerfile name is now "builder.Dockerfile" too.

## 0.3.0

- Change `NextjsDistributionProps.loadBalancer` type from `ILoadBalancerV2` to `ApplicationLoadBalancer`
- Remove `NextjsDistributionOverrides.dynamicLoadBalancerV2OriginProps` (replaced with `NextjsDistributionOverrides.dynamicVpcOriginWithEndpointProps`)
- `NextjsGlobalContainers` will now deploy ALB in PrivateWithEgress subnet. Previously these ALBs were created in Public subnet but with more secure CloudFront VPC Origin Access now available in CDK we can put ALB in PrivateWithEgressSubnet. This change requires replacement of the AWS::ElasticLoadBalancingV2::LoadBalancer. Because the target groups are not directly linked to the load balancer (so they're not replaced too), you'll get the error: `The following target groups cannot be associated with more than one load balancer`. To work around this issue, please see AWS re:Post solution: [Error: TargetGroup cannot be associated with more than one load balancer](https://repost.aws/questions/QUY2sMSJyDTL-vNbR4Agm0Yw/error-targetgroup-cannot-be-associated-with-more-than-one-load-balancer) for workaround. Alternatively, you can simply destroy and re-deploy the stack.

## 0.2.0

- Removed Lambda@Edge Function from `NextjsGlobalFunctions`
- Updated `NextjsDistribution`'s dynamic origins to use `FunctionUrlOrigin.withOriginAccessControl` or `LoadBalancerV2Origin` removing generic `HttpOrigin`. This sets us up for `VpcOriginOAC` when released for `Nextjs...Containers` to improve security
- `NextjsDistributionOverrides.edgeFunctionProps` removed
- `NextjsDistributionOverrides.dynamicHttpOriginProps` removed
- `NextjsDistributionProps.dynamicUrl` removed
- `NextjsDistributionProps.functionArn` removed
- `NextjsDistributionProps.loadBalancer` required if containers
- `NextjsDistributionProps.functionUrl` required if functions
- `NextjsAssetsDeployment.nextjsType` required

## 0.1.0

- Use `cloudfront.experimental.EdgeFunction` for SignFnUrl within `NextjsDistribution` resulting in "Error: stacks which use EdgeFunctions must have an explicitly set region" if you haven't explicitly set region.
- Omit `overrides` from following generated structs: `OptionalNextjsAssetsDeploymentProps`, `OptionalNextjsBuildProps`, `OptionalNextjsContainersProps`, `OptionalNextjsDistributionProps`, `OptionalNextjsFileSystemProps`, `OptionalNextjsInvalidationProps`, `OptionalNextjsVpcProps`.
- `NextjsGlobalFunctionsOverrides.nextjsFunction` -> `NextjsGlobalFunctionsOverrides.nextjsFunctions`
- `NextjsGlobalFunctionsConstructOverrides.nextjsFunction` -> `NextjsGlobalFunctionsConstructOverrides.nextjsFunctions`
