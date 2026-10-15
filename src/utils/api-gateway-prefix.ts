import { Token } from "aws-cdk-lib";
import { RestApiProps } from "aws-cdk-lib/aws-apigateway";
import { ApiGatewayPrefix } from "./base-path";

/**
 * The prefix API Gateway will strip, read from the `restApiProps` override
 * `NextjsApi` builds its `RestApi` from: a custom domain's base path mapping
 * (`""` when mapped at the root) when `domainName` is set, else the stage name,
 * `RestApi`'s `prod` by default. A token reads as unknown.
 *
 * Kept out of `base-path.ts`, which the runtime bundles import, because it
 * needs `aws-cdk-lib`'s `Token`.
 *
 * A domain attached later with `api.addDomainName()` is invisible here, the
 * same limitation `NextjsApi.url` documents.
 */
export function apiGatewayPrefixFrom(
  restApiProps?: RestApiProps,
): ApiGatewayPrefix {
  const domainName = restApiProps?.domainName;
  const strippedPrefix = domainName
    ? (domainName.basePath ?? "")
    : (restApiProps?.deployOptions?.stageName ?? "prod");
  return {
    strippedPrefix: Token.isUnresolved(strippedPrefix)
      ? undefined
      : strippedPrefix,
    customDomain: domainName !== undefined,
  };
}
