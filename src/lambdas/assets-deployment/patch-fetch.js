// NOTE: we use JS here b/c this projen project doesn't have browser DOM types
// and I cannot edit the tsconfig because: https://github.com/projen/projen/discussions/3202#discussioncomment-7958381
/*
  For `NextjsFunctions`, CloudFront is configured to use Lambda Function URL OAC
  which is a managed way to sign requests to Lambda Function URLs. `NextjsFunctions`
  configures Lambda Function URLS to require IAM_AUTH for improved security,
  so signing requests is required. One limitation of Lambda Function URL OAC
  documented [here](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html)
  is that if you use a PUT or POST method then the client must supply the hash
  of the payload in a x-amz-content-sha256 header. This code below is prepended
  to the .next/static/chunks/main-app-***.js from `next build` output to ensure
  `fetch` and `XMLHttpRequest` PUT and POST requests include this header with
  the hash and therefore can be signed by OAC and invoked Lambda Function URL.
*/

async function calculateSha256(content) {
  // Using the crypto API for browser environments
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const originalFetch = window.fetch;
const OriginalXHR = window.XMLHttpRequest;

// Helper function to convert FormData to string
function formDataToString(formData) {
  const pairs = [];
  for (const [key, value] of formData.entries()) {
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return pairs.join("&");
}

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
  const url =
    typeof input === "string"
      ? new URL(input, window.location.href)
      : new URL(input.url);
  if (url.hostname !== window.location.hostname) {
    return originalFetch(input, init);
  }

  const body = init.body;
  let bodyContent;
  if (body) {
    if (typeof body === "string") {
      bodyContent = body;
    } else if (body instanceof FormData) {
      bodyContent = formDataToString(body);
    } else if (body instanceof Blob || body instanceof ArrayBuffer) {
      bodyContent = await body.text();
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
  const headers = new Headers(init.headers);
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
