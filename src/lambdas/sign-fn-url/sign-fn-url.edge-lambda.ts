import type { CloudFrontRequest, CloudFrontRequestHandler } from "aws-lambda";
import { signRequest } from "./sign-request";

const debug = true;

/**
 * This Lambda@Edge handler fixes s3 requests, fixes the host header, and
 * signs requests as they're destined for Lambda Function URL that requires
 * IAM Auth.
 *
 * This can be deleted/removed when CloudFront OAC Lambda supports POST requests.
 */
export const handler: CloudFrontRequestHandler = async (event) => {
  const request = event.Records[0]?.cf.request;
  if (!request) throw new Error("request missing");
  if (debug) console.log("input request", JSON.stringify(request, null, 2));

  escapeQuerystring(request);
  await signRequest(request);

  if (debug) console.log("output request", JSON.stringify(request), null, 2);
  return request;
};

/**
 * Lambda URL will reject query parameters with brackets so we need to encode
 * https://github.dev/pwrdrvr/lambda-url-signing/blob/main/packages/edge-to-origin/src/translate-request.ts#L19-L31
 */
function escapeQuerystring(request: CloudFrontRequest) {
  request.querystring = request.querystring
    .replace(/\[/g, "%5B")
    .replace(/]/g, "%5D");
}
