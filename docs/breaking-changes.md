# Breaking Changes

## 0.1.0

- Use `cloudfront.experimental.EdgeFunction` for SignFnUrl within `NextjsDistribution` resulting in "Error: stacks which use EdgeFunctions must have an explicitly set region" if you haven't explicitly set region.
- Omit `overrides` from following generated structs: `OptionalNextjsAssetsDeploymentProps`, `OptionalNextjsBuildProps`, `OptionalNextjsContainersProps`, `OptionalNextjsDistributionProps`, `OptionalNextjsFileSystemProps`, `OptionalNextjsInvalidationProps`, `OptionalNextjsVpcProps`.
- `NextjsGlobalFunctionsOverrides.nextjsFunction` -> `NextjsGlobalFunctionsOverrides.nextjsFunctions`
- `NextjsGlobalFunctionsConstructOverrides.nextjsFunction` -> `NextjsGlobalFunctionsConstructOverrides.nextjsFunctions`
