# Breaking Changes

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
