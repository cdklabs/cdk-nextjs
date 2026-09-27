// Patch `fetch`/`XMLHttpRequest` to add the `x-amz-content-sha256` header to
// same-origin POST/PUT requests. Required by `NextjsGlobalFunctions`, whose
// server is a Lambda Function URL with `AuthType: AWS_IAM` behind a CloudFront
// origin access control: CloudFront signs the origin request with SigV4 but will
// not hash a request body, and Lambda rejects unsigned payloads. Without this
// header every server action, form submission and POST route handler is answered
// `403 InvalidSignatureException` before it reaches Next.js.
//
// Written against `globalThis`, not `window`, because the chunks this is
// prepended to do not all run on the main thread. Turbopack emits its web-worker
// bootstrap as `static/chunks/turbopack-worker-*.js`, which the entrypoint
// selector matches, and a worker has no `window` — reading `window.fetch` there
// threw `ReferenceError: window is not defined` before the worker's own module
// ran, so `new Worker(new URL(…))` never came up. `globalThis`, `location` and
// `fetch` exist in both scopes, so one patch covers both and a worker's own
// same-origin POSTs get signed too. `XMLHttpRequest` does not exist in every
// worker scope, hence the guard below.
//
// See src/nextjs-build/nextjs-build.ts `patchFetchInClientJs`, which prepends
// this file to the client entrypoint chunks, and
// https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html

async function sha256(data) {
  const msgBuffer =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The exact bytes a `fetch` or `XMLHttpRequest` body is sent as, which is what
// the hash has to cover. `body` is what to send instead of the original, and
// `contentType` the header to send with it, when the original cannot be sent
// as-is: a `FormData` is encoded here (so its boundary is known), and the
// encoding replaces it.
async function encodeBody(body) {
  if (!body) return { bytes: new Uint8Array(0), body };
  if (typeof body === "string") {
    return { bytes: new TextEncoder().encode(body), body };
  }
  if (body instanceof FormData) {
    // Encode via Response so File/Blob parts survive as bytes. The hash must
    // cover the exact sent bytes (incl. boundary), so the encoding becomes the body.
    const encoded = new Response(body);
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    return {
      bytes,
      body: bytes,
      contentType: encoded.headers.get("content-type") ?? undefined,
    };
  }
  if (body instanceof Blob) {
    return { bytes: new Uint8Array(await body.arrayBuffer()), body };
  }
  if (body instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(body), body };
  }
  if (ArrayBuffer.isView(body)) {
    // A typed array or `DataView` is sent as the bytes it views - which is
    // also what the `FormData` branch above hands on as the body.
    return {
      bytes: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
      body,
    };
  }
  if (body instanceof URLSearchParams) {
    return { bytes: new TextEncoder().encode(body.toString()), body };
  }
  // Anything else is sent stringified (an XHR `Document` aside, which is rare
  // enough to leave unsigned-correct), so hash what it stringifies to.
  return { bytes: new TextEncoder().encode(String(body)), body };
}

// Set on the wrappers below, so that a second copy of this file sharing the
// global scope leaves them alone. `patchFetchInClientJs` prepends it to every
// entrypoint chunk, and a page can load more than one. Wrapped twice, the outer
// wrapper re-encodes a `FormData` body as a `Uint8Array` and the inner one then
// hashed *that* as JSON, overwriting the right header with a wrong one: a 403.
// The top-level declarations need no IIFE of their own to coexist: esbuild
// bundles this file into one (see `.projenrc.ts`), and that is what ships.
const PATCHED = Symbol.for("cdk-nextjs:patch-fetch");

const originalFetch = globalThis.fetch;

async function signedFetch(input, init) {
  if (!init) return originalFetch(input, init);

  const method = init.method?.toUpperCase();
  if (method !== "PUT" && method !== "POST") {
    return originalFetch(input, init);
  }

  let url;
  if (typeof input === "string") {
    url = new URL(input, location.href);
  } else if (input instanceof URL) {
    url = input;
  } else if (input instanceof Request) {
    url = new URL(input.url, location.href);
  } else {
    url = new URL(String(input), location.href);
  }
  if (url.hostname !== location.hostname) {
    return originalFetch(input, init);
  }

  const headers = new Headers(init.headers);
  const encoded = await encodeBody(init.body);
  if (encoded.contentType) headers.set("content-type", encoded.contentType);
  if (encoded.body !== init.body) init.body = encoded.body;
  const bodyBytes = encoded.bytes;

  const contentSha256 = await sha256(bodyBytes);
  headers.set("x-amz-content-sha256", contentSha256);
  init.headers = headers;

  return originalFetch(input, init);
}

// Patch fetch
if (!originalFetch[PATCHED]) {
  signedFetch[PATCHED] = true;
  globalThis.fetch = signedFetch;
}

// Patch XMLHttpRequest, where there is one. A service worker scope has no
// `XMLHttpRequest`, and `class extends undefined` is a TypeError.
if (
  typeof globalThis.XMLHttpRequest !== "undefined" &&
  !globalThis.XMLHttpRequest[PATCHED]
) {
  const originalXMLHttpRequest = globalThis.XMLHttpRequest;

  globalThis.XMLHttpRequest = class extends originalXMLHttpRequest {
    constructor() {
      super();
      this.method = "";
      this.url = "";
      this.originalOpen = super.open;
      this.originalSend = super.send;

      super.open = (method, url, ...args) => {
        this.method = method.toUpperCase();
        this.url = url;
        this.originalOpen.apply(this, [method, url, ...args]);
      };

      super.send = async (body) => {
        if (
          (this.method === "PUT" || this.method === "POST") &&
          new URL(this.url, location.href).hostname === location.hostname &&
          body
        ) {
          // Through the same encoding as `fetch`: hashing `JSON.stringify` of
          // a `FormData`, `Blob` or typed array hashed `{}` rather than the bytes
          // XHR sends, and every such upload was a 403.
          const encoded = await encodeBody(body);
          if (encoded.contentType) {
            this.setRequestHeader("content-type", encoded.contentType);
          }
          body = encoded.body;
          const contentSha256 = await sha256(encoded.bytes);
          this.setRequestHeader("x-amz-content-sha256", contentSha256);
        }
        this.originalSend.apply(this, [body]);
      };
    }
  };
  globalThis.XMLHttpRequest[PATCHED] = true;
}
