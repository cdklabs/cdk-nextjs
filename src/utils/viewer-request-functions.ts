import { Token } from "aws-cdk-lib";
import { FunctionEventType } from "aws-cdk-lib/aws-cloudfront";
import { LOG_PREFIX } from "../constants";

/**
 * The code of cdk-nextjs's CloudFront Functions, and of `viewerRequestFunctionCode`
 * spliced into them, and the checks on both. Synth-time only (it imports
 * `aws-cdk-lib`): `NextjsDistribution` creates the functions.
 */

/**
 * Where a viewer-request handler calls `viewerRequestFunctionCode`, before any
 * logic of its own. Replaced at synth, never deployed.
 */
export const VIEWER_REQUEST_HOOK = "/*@viewerRequest@*/";

/**
 * CloudFront's maximum CloudFront Function size.
 * @see https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-functions
 */
export const MAX_FUNCTION_CODE_BYTES = 10 * 1024;

// Next.js answers any path containing a backslash or a repeated
// slash with a 308 to the collapsed path
// (`normalizeRepeatedSlashes`, called from `base-server.ts`), and so
// does this runtime. Behind a Lambda Function URL the origin never
// gets the chance: Origin Access Control signs the raw path while the
// Function URL canonicalizes it before verifying, so the origin
// answers 403 SignatureDoesNotMatch. Doing the redirect here is what
// makes `/basepath//to-sv` behave as it does under `next start`.
//
// A bare `//` reaches here too, and is answered the same way -
// measured, because `//` at the start of a request target is also the
// authority form and it was not obvious CloudFront would route it to a
// function at all. It does: `GET //` answers 308 to `/` with
// `x-cache: FunctionGeneratedResponse`, over both HTTP/1.1 and HTTP/2,
// which is what `test/e2e/hydration` asks for.
//
// Two things Next.js does that this does not:
//
// - the body it sends with its own redirect (the destination, as
//   text). A generated response can carry one on
//   cloudfront-js-2.0, but none is sent yet; no known client reads
//   it.
// - the original order of the query string. The event exposes
//   `querystring` as an object, never as the raw string, so
//   `/x//y?a=1&b=2` redirects to `/x/y?b=2&a=1`. The pairs all
//   survive; only their order is CloudFront's rather than the
//   client's, and a redirect target is not order-sensitive.
//
// A repeated key's `multiValue` already holds its first value, which
// `value` repeats, so it is one or the other, never both. Names and
// values arrive as the client sent them, still percent-encoded
// (measured: `?a=%20b%26c&p=1+2` reads back unchanged), so they are
// joined as-is; encoding them again would turn `%20` into `%2520`.
//
// These notes live out here rather than in the code because
// CloudFront counts comments toward the function's 10 KB, which
// `viewerRequestFunctionCode` shares.
//
// Only the ES6+ that cloudfront-js-2.0 documents: `const`/`let`, arrow
// functions, `Object.keys`; no destructuring, spread or `for...of`.
// Strings are concatenated rather than templated, since a template
// literal in here would need every backtick and `${` escaped.
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-20.html

/**
 * NextjsGlobalFunctions' viewer-request handler: redirects repeated slashes,
 * and overwrites `x-forwarded-host` with the viewer's `Host` so Next.js
 * `request.url` is the site's domain rather than the Function URL's.
 * @see https://open-next.js.org/advanced/workaround#workaround-set-x-forwarded-host-header-aws-specific
 */
export const X_FORWARDED_HOST_HANDLER = `
  async function handler(event) {${VIEWER_REQUEST_HOOK}
    const request = event.request;
    const uri = request.uri;

    if (/\\\\|\\/\\//.test(uri)) {
      let location = uri.replace(/\\\\/g, "/").replace(/\\/\\/+/g, "/");
      const qs = [];
      Object.keys(request.querystring).forEach((name) => {
        const q = request.querystring[name];
        (q.multiValue || [q]).forEach((entry) => {
          qs.push(entry.value === "" ? name : name + "=" + entry.value);
        });
      });
      if (qs.length) {
        location += "?" + qs.join("&");
      }
      return {
        statusCode: 308,
        statusDescription: "Permanent Redirect",
        headers: { location: { value: location } },
      };
    }

    request.headers["x-forwarded-host"] = request.headers.host;
    return request;
  }
  `;

/**
 * The handler of a behavior with no viewer-request logic of its own, which
 * only runs `viewerRequestFunctionCode`.
 */
export const PASS_THROUGH_HANDLER = `
  async function handler(event) {${VIEWER_REQUEST_HOOK}
    return event.request;
  }
  `;

/**
 * The `assetPrefix` behavior's handler: an S3 origin keys on the request URI
 * and `originPath` can only prepend, so the prefix is swapped for the
 * `basePath` here. Both are synth-time literals.
 */
export function assetPrefixRewriteHandler(
  basePath: string,
  assetPrefix: string,
): string {
  return `
  async function handler(event) {${VIEWER_REQUEST_HOOK}
    const request = event.request;
    request.uri = ${JSON.stringify(
      basePath ? `/${basePath}` : "",
    )} + request.uri.slice(${assetPrefix.length});
    return request;
  }
  `;
}

/**
 * Checks `viewerRequestFunctionCode` defines `viewerRequest` and doesn't use
 * the name `handler`.
 *
 * Any use of `handler` is refused, not just a declaration: an assignment
 * (`var handler =`, destructuring, `globalThis["handler"] =`) would replace
 * cdk-nextjs's handler, and with it the `x-forwarded-host` overwrite, and a
 * `let`/`const`/`class` would make the file a syntax error. Telling these
 * apart from a local of the same name takes a parser, so a local, or the
 * word in a comment or string, is refused too; that errs towards refusing
 * code that would have worked.
 */
export function checkViewerRequestCode(userCode: string): void {
  if (
    !/\bfunction\s+viewerRequest\s*\(|(?:\b(?:var|let|const)\s+|,\s*)viewerRequest\s*=(?!=)/.test(
      userCode,
    )
  ) {
    throw new Error(
      `${LOG_PREFIX} \`viewerRequestFunctionCode\` must define ` +
        `\`viewerRequest(event)\`, as a function or a \`var\`/\`let\`/` +
        `\`const\`, which cdk-nextjs calls from its own viewer-request ` +
        `handler.`,
    );
  }
  if (/\bhandler\b/.test(userCode)) {
    throw new Error(
      `${LOG_PREFIX} \`viewerRequestFunctionCode\` uses the name ` +
        `\`handler\`, which is cdk-nextjs's own function in the same file. ` +
        `Rename it (a mention in a comment or string counts too); your entry ` +
        `point is \`viewerRequest\`, called with the same event, and it may ` +
        `return the same request or response.`,
    );
  }
}

/**
 * The deployed code of a cdk-nextjs handler: with `userCode` first in the file
 * (where CloudFront wants `import cf from "cloudfront"`) and awaited where the
 * handler says {@link VIEWER_REQUEST_HOOK}, or with the marker dropped when
 * there is none. Indentation is dropped too, since it counts toward the
 * 10 KB; none of this code has a multi-line string for that to change.
 */
export function spliceViewerRequest(
  handler: string,
  userCode: string | undefined,
): string {
  const dedent = (code: string) => code.replace(/^[ \t]+/gm, "");
  if (userCode === undefined) {
    return dedent(handler.replace(VIEWER_REQUEST_HOOK, ""));
  }
  // A response has a status; anything else returned is the request to carry
  // on with. `await` takes a synchronous `viewerRequest` as it is.
  return `${userCode}\n${dedent(
    handler.replace(
      VIEWER_REQUEST_HOOK,
      `
      const viewerResult = await viewerRequest(event);
      if (viewerResult && viewerResult.statusCode) {
        return viewerResult;
      }
      if (viewerResult) {
        event.request = viewerResult;
      }`,
    ),
  )}`;
}

/**
 * Throw when a function's code, `viewerRequestFunctionCode` spliced in, is over
 * {@link MAX_FUNCTION_CODE_BYTES}. `"unresolved"` when it contains a CDK token,
 * whose placeholder isn't the length of what it resolves to, so the size can't
 * be checked until deploy.
 */
export function checkFunctionCodeSize(code: string): "unresolved" | undefined {
  if (Token.isUnresolved(code)) {
    return "unresolved";
  }
  const size = Buffer.byteLength(code);
  if (size > MAX_FUNCTION_CODE_BYTES) {
    throw new Error(
      `${LOG_PREFIX} \`viewerRequestFunctionCode\` makes a CloudFront ` +
        `Function of ${size} bytes, cdk-nextjs's own code included, over ` +
        `CloudFront's limit of ${MAX_FUNCTION_CODE_BYTES}. Shorten it ` +
        `(comments and whitespace count). See ` +
        `https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-functions`,
    );
  }
  return undefined;
}

/**
 * CloudFront allows one function per event type per behavior, so an
 * override's viewer-request association and one cdk-nextjs needs can't both
 * be kept. Thrown at synth, where both halves are known, rather than left to
 * a deploy that names neither.
 */
export function assertViewerRequestUnclaimed(
  overrideName: string,
  associations:
    readonly { readonly eventType: FunctionEventType }[] | undefined,
  needs: string,
) {
  const claimed = (associations ?? []).some(
    (association) => association.eventType === FunctionEventType.VIEWER_REQUEST,
  );
  if (claimed) {
    throw new Error(
      `${LOG_PREFIX} \`overrides.${overrideName}.functionAssociations\` ` +
        `associates a CloudFront function with ` +
        `${FunctionEventType.VIEWER_REQUEST}, but ${needs}. ` +
        `CloudFront permits only one function per event type per behavior. ` +
        `Move the logic into \`viewerRequestFunctionCode\`, which runs ` +
        `inside cdk-nextjs's own viewer-request function on every behavior.`,
    );
  }
}
