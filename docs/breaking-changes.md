# Breaking Changes

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
