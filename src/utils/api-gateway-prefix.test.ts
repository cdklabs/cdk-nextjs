import { Lazy, Stack } from "aws-cdk-lib";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { apiGatewayPrefixFrom } from "./api-gateway-prefix";

const certificate = Certificate.fromCertificateArn(
  new Stack(),
  "Certificate",
  "arn:aws:acm:us-east-1:123456789012:certificate/abc",
);
const token = () => Lazy.string({ produce: () => "v1" });

describe("apiGatewayPrefixFrom", () => {
  it("defaults to RestApi's prod stage and no custom domain", () => {
    expect(apiGatewayPrefixFrom()).toEqual({
      strippedPrefix: "prod",
      customDomain: false,
    });
    expect(apiGatewayPrefixFrom({})).toEqual({
      strippedPrefix: "prod",
      customDomain: false,
    });
    expect(apiGatewayPrefixFrom({ deployOptions: {} })).toEqual({
      strippedPrefix: "prod",
      customDomain: false,
    });
  });

  it("reads the stage name without a custom domain", () => {
    expect(
      apiGatewayPrefixFrom({ deployOptions: { stageName: "v1" } }),
    ).toEqual({ strippedPrefix: "v1", customDomain: false });
  });

  it("reads the domain's base path mapping over the stage name", () => {
    expect(
      apiGatewayPrefixFrom({
        deployOptions: { stageName: "v1" },
        domainName: {
          domainName: "app.example.com",
          certificate,
          basePath: "docs",
        },
      }),
    ).toEqual({ strippedPrefix: "docs", customDomain: true });
  });

  it("maps a custom domain without a base path at the root", () => {
    expect(
      apiGatewayPrefixFrom({
        deployOptions: { stageName: "v1" },
        domainName: { domainName: "app.example.com", certificate },
      }),
    ).toEqual({ strippedPrefix: "", customDomain: true });
  });

  it("treats a token stage name or base path as unknown", () => {
    expect(
      apiGatewayPrefixFrom({ deployOptions: { stageName: token() } }),
    ).toEqual({ strippedPrefix: undefined, customDomain: false });
    expect(
      apiGatewayPrefixFrom({
        domainName: {
          domainName: "app.example.com",
          certificate,
          basePath: token(),
        },
      }),
    ).toEqual({ strippedPrefix: undefined, customDomain: true });
  });
});
