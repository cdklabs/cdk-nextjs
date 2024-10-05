// we bundle lambdas during build, so below dependencies actually don't need to be included in "dependencies"
// eslint-disable-next-line import/no-extraneous-dependencies
import { Sha256 } from "@aws-crypto/sha256-js";
// eslint-disable-next-line import/no-extraneous-dependencies
import { SignatureV4 } from "@smithy/signature-v4";
import type { CloudFrontHeaders, CloudFrontRequest } from "aws-lambda";

let sigv4: SignatureV4;

/**
 * Enables use of IAM_AUTH on Lambda Function URL
 * @link https://medium.com/@dario_26152/restrict-access-to-lambda-functionurl-to-cloudfront-using-aws-iam-988583834705
 */
export async function signRequest(request: CloudFrontRequest) {
  if (!sigv4) {
    const region = getRegionFromLambdaUrl(
      request.origin?.custom?.domainName || "",
    );
    sigv4 = getSigV4(region);
  }
  // remove x-forwarded-for b/c it changes from hop to hop
  delete request.headers["x-forwarded-for"];
  const headerBag = cfHeadersToHeaderBag(request.headers);
  const hostname = headerBag.host;
  if (!hostname) throw new Error("host header missing");
  let body: string | undefined;
  if (request.body?.data) {
    body = Buffer.from(request.body.data, "base64").toString();
  }
  const params = queryStringToQueryParamBag(request.querystring);
  const signed = await sigv4.sign({
    method: request.method,
    headers: headerBag,
    hostname,
    path: request.uri,
    body,
    query: params,
    protocol: "https",
  });
  request.headers = headerBagToCfHeaders(signed.headers);
}

function getSigV4(region: string): SignatureV4 {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!region) throw new Error("AWS_REGION missing");
  if (!accessKeyId) throw new Error("AWS_ACCESS_KEY_ID missing");
  if (!secretAccessKey) throw new Error("AWS_SECRET_ACCESS_KEY missing");
  if (!sessionToken) throw new Error("AWS_SESSION_TOKEN missing");
  return new SignatureV4({
    service: "lambda",
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      sessionToken,
    },
    sha256: Sha256,
  });
}

export function getRegionFromLambdaUrl(url: string): string {
  const region = url.split(".").at(2);
  if (!region)
    throw new Error("Region couldn't be extracted from Lambda Function URL");
  return region;
}

/**
 * Bag or Map used for HeaderBag or QueryStringParameterBag for `sigv4.sign()`
 */
type Bag = Record<string, string>;
/**
 * Converts CloudFront headers (can have array of header values) to simple
 * header bag (object) required by `sigv4.sign`
 *
 * NOTE: only includes headers allowed by origin policy to prevent signature
 * mismatch
 */
export function cfHeadersToHeaderBag(headers: CloudFrontHeaders): Bag {
  const headerBag: Bag = {};
  // assume first header value is the best match
  // headerKey is case insensitive whereas key (adjacent property value that is
  // not destructured) is case sensitive. we arbitrarily use case insensitive key
  for (const [headerKey, [headerObj]] of Object.entries(headers)) {
    const value = headerObj?.value;
    if (value) {
      headerBag[headerKey] = value;
    }
  }
  return headerBag;
}

/**
 * Converts simple header bag (object) to CloudFront headers
 */
export function headerBagToCfHeaders(headerBag: Bag): CloudFrontHeaders {
  const cfHeaders: CloudFrontHeaders = {};
  for (const [headerKey, value] of Object.entries(headerBag)) {
    /*
      When your Lambda function adds or modifies request headers and you don't include the header key field, Lambda@Edge automatically inserts a header key using the header name that you provide. Regardless of how you've formatted the header name, the header key that's inserted automatically is formatted with initial capitalization for each part, separated by hyphens (-).
      See: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-event-structure.html
    */
    cfHeaders[headerKey] = [{ value }];
  }
  return cfHeaders;
}

/**
 * Converts CloudFront querystring to QueryParamaterBag for IAM Sig V4
 */
export function queryStringToQueryParamBag(querystring: string): Bag {
  const oldParams = new URLSearchParams(querystring);
  const newParams: Bag = {};
  for (const [k, v] of oldParams) {
    newParams[k] = v;
  }
  return newParams;
}
