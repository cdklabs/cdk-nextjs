// @ts-check

// NOTE: we use JS here b/c this projen project doesn't have browser DOM types
// and I cannot edit the tsconfig because: https://github.com/projen/projen/discussions/3202#discussioncomment-7958381
// but adding @ ts-check at top enables browser APIs somehow!
/*
  For `NextjsFunctions`, CloudFront is configured to use Lambda Function URL OAC
  which is a managed way to sign requests to Lambda Function URLs. `NextjsFunctions`
  configures Lambda Function URLS to require IAM_AUTH for improved security,
  so signing requests is required. One limitation of CloudFront Function URL OAC
  documented [here](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)
  is that if you use a PUT or POST method then the client must supply the hash
  of the payload in a x-amz-content-sha256 header. This code below is prepended
  to the .next/static/chunks/main-app-***.js from `next build` output to ensure
  `fetch` and `XMLHttpRequest` PUT and POST requests include this header with
  the hash and therefore can invoke the IAM_AUTH secured Lambda Function URL.
*/

const originalFetch = window.fetch;
const OriginalXHR = window.XMLHttpRequest;

// Patch fetch
window.fetch = async function patchedFetch(input, init) {
  if (!init) {
    return originalFetch(input, init);
  }

  const method = init.method?.toUpperCase();
  if (method !== "PUT" && method !== "POST") {
    return originalFetch(input, init);
  }

  // Only patch requests to the current domain
  let urlObj;
  if (typeof input === "string") {
    urlObj = new URL(input, window.location.href);
  } else if (input instanceof URL) {
    urlObj = input;
  } else if (input instanceof Request) {
    urlObj = new URL(input.url, window.location.href);
  } else {
    // fallback, just in case
    urlObj = new URL(String(input), window.location.href);
  }

  if (urlObj.hostname !== window.location.hostname) {
    return originalFetch(input, init);
  }

  const body = init.body;
  let bodyContent;
  const headers = new Headers(init.headers);
  if (body) {
    if (typeof body === "string") {
      bodyContent = body;
    } else if (body instanceof FormData) {
      const formBoundary =
        "----FormBoundary" + Math.random().toString(16).slice(2);
      bodyContent = createMultiPartFormBody(formBoundary, body);
      // browser will automatically set this header if <form enctype="multipart/form-data">
      // but then we don't have access to body to hash, so we generate ourselves
      headers.set(
        "content-type",
        `multipart/form-data; boundary=${formBoundary}`,
      );
      // overwrite the FormData body with raw multipart form-data body
      init.body = bodyContent;
    } else if (body instanceof Blob) {
      bodyContent = await body.text();
    } else if (body instanceof ArrayBuffer) {
      // Pass the ArrayBuffer directly as a Uint8Array which is needed to hash
      bodyContent = new Uint8Array(body);
    } else {
      bodyContent = JSON.stringify(body);
    }
  } else {
    // according to AWS's SigV4 signing requirements, even requests with empty
    // bodies must have a valid x-amz-content-sha256 header
    bodyContent = "";
  }
  const contentHash = await calculateSha256(bodyContent);
  // Add or update headers
  headers.set("x-amz-content-sha256", contentHash);
  init.headers = headers;

  return originalFetch(input, init);
};

// Patch XMLHttpRequest
window.XMLHttpRequest = class PatchedXMLHttpRequest extends OriginalXHR {
  method = "";
  url = "";

  constructor() {
    super();
    this.originalOpen = super.open;
    this.originalSend = super.send;

    // Override open
    super.open = (method, url, ...args) => {
      this.method = method.toUpperCase();
      this.url = url;
      this.originalOpen.apply(this, [method, url, ...args]);
    };

    // Override send
    super.send = async (body) => {
      if (
        (this.method === "PUT" || this.method === "POST") &&
        new URL(this.url, window.location.href).hostname ===
          window.location.hostname
      ) {
        if (body) {
          const bodyString =
            typeof body === "string" ? body : JSON.stringify(body);
          const contentHash = await calculateSha256(bodyString);
          this.setRequestHeader("x-amz-content-sha256", contentHash);
        }
      }
      this.originalSend.apply(this, [body]);
    };
  }
};

async function calculateSha256(content) {
  // Using the crypto API for browser environments
  let data;
  if (content instanceof Uint8Array) {
    data = content;
  } else {
    const encoder = new TextEncoder();
    data = encoder.encode(content);
  }
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Create raw multipart/form-data being sent to the server. Next.js Server
 * Actions set `encType="multipart/form-data"` on `<form>` when using `action`
 * property instead of default `enctype="application/x-www-form-urlencoded"`.
 * Therefore, we need to reconstruct the raw body format to hash.
 * 
 * @param {string} formBoundary
 * @param {FormData} formData
 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Type#content-type_in_multipart_forms
 * 
 * @example
 * createMultiPartFormBody("FormBoundary0.eb6ebcebbb9788", body)
```
------FormBoundary0.eb6ebcebbb9788
Content-Disposition: form-data; name="1_$ACTION_ID_b3cccc9c44c84d9ed2c08bf67acd81674725b41b"


------FormBoundary0.eb6ebcebbb9788
Content-Disposition: form-data; name="1_name"

Ben
------FormBoundary0.eb6ebcebbb9788
Content-Disposition: form-data; name="0"

["$K1"]
------FormBoundary0.eb6ebcebbb9788--
```
 */
function createMultiPartFormBody(formBoundary, formData) {
  // Create a consistent boundary format like Next.js uses
  let content = "";

  // Iterate through FormData entries and build the multipart body
  for (const [key, value] of formData.entries()) {
    // Add boundary
    content += `--${formBoundary}\r\n`;
    // Add Content-Disposition header
    content += `Content-Disposition: form-data; name="${key}"\r\n`;
    // Add required empty line
    content += "\r\n";
    // Add value
    content += `${value}\r\n`;
  }

  // Add closing boundary
  content += `--${formBoundary}--`;

  return content;
}
