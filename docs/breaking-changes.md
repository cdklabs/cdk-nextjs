# Breaking Changes

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
