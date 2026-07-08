// Patch fetch to add x-amz-content-sha256 header for AWS S3 requests
// This is required for S3 cache operations to work correctly with AWS signature v4

async function sha256(data) {
  const msgBuffer =
    typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

const originalFetch = window.fetch;
const originalXMLHttpRequest = window.XMLHttpRequest;

// Patch window.fetch
window.fetch = async function (input, init) {
  if (!init) return originalFetch(input, init);

  const method = init.method?.toUpperCase();
  if (method !== "PUT" && method !== "POST") {
    return originalFetch(input, init);
  }

  let url;
  if (typeof input === "string") {
    url = new URL(input, window.location.href);
  } else if (input instanceof URL) {
    url = input;
  } else if (input instanceof Request) {
    url = new URL(input.url, window.location.href);
  } else {
    url = new URL(String(input), window.location.href);
  }
  if (url.hostname !== window.location.hostname) {
    return originalFetch(input, init);
  }

  const body = init.body;
  let bodyBytes;
  const headers = new Headers(init.headers);

  if (body) {
    if (typeof body === "string") {
      bodyBytes = new TextEncoder().encode(body);
    } else if (body instanceof FormData) {
      // Encode via Response so File/Blob parts survive as bytes. The hash must
      // cover the exact sent bytes (incl. boundary), so the encoding becomes the body.
      const encoded = new Response(body);
      bodyBytes = new Uint8Array(await encoded.arrayBuffer());
      const contentType = encoded.headers.get("content-type");
      if (contentType) headers.set("content-type", contentType);
      init.body = bodyBytes;
    } else if (body instanceof Blob) {
      bodyBytes = new Uint8Array(await body.arrayBuffer());
    } else if (body instanceof ArrayBuffer) {
      bodyBytes = new Uint8Array(body);
    } else if (body instanceof URLSearchParams) {
      bodyBytes = new TextEncoder().encode(body.toString());
    } else {
      bodyBytes = new TextEncoder().encode(JSON.stringify(body));
    }
  } else {
    bodyBytes = new Uint8Array(0);
  }

  const contentSha256 = await sha256(bodyBytes);
  headers.set("x-amz-content-sha256", contentSha256);
  init.headers = headers;

  return originalFetch(input, init);
};

// Patch XMLHttpRequest
window.XMLHttpRequest = class extends originalXMLHttpRequest {
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
        new URL(this.url, window.location.href).hostname ===
          window.location.hostname &&
        body
      ) {
        const bodyString =
          typeof body === "string"
            ? body
            : body instanceof URLSearchParams
              ? body.toString()
              : JSON.stringify(body);
        const contentSha256 = await sha256(bodyString);
        this.setRequestHeader("x-amz-content-sha256", contentSha256);
      }
      this.originalSend.apply(this, [body]);
    };
  }
};
