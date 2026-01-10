// Patch fetch to add x-amz-content-sha256 header for AWS S3 requests
// This is required for S3 cache operations to work correctly with AWS signature v4

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

const originalFetch = window.fetch;
const originalXMLHttpRequest = window.XMLHttpRequest;

function createFormDataString(boundary, formData) {
  let result = "";
  for (const [name, value] of formData.entries()) {
    result += `--${boundary}\r\n`;
    result += `Content-Disposition: form-data; name="${name}"\r\n`;
    result += "\r\n";
    result += `${value}\r\n`;
  }
  result += `--${boundary}--`;
  return result;
}

// Patch window.fetch
window.fetch = async function (input, init) {
  if (!init) return originalFetch(input, init);

  const method = init.method?.toUpperCase();
  if (method !== "PUT" && method !== "POST") {
    return originalFetch(input, init);
  }

  const url =
    typeof input === "string"
      ? new URL(input, window.location.href)
      : new URL(input.url);
  if (url.hostname !== window.location.hostname) {
    return originalFetch(input, init);
  }

  const body = init.body;
  let bodyString;
  const headers = new Headers(init.headers);

  if (body) {
    if (typeof body === "string") {
      bodyString = body;
    } else if (body instanceof FormData) {
      const boundary = "----FormBoundary" + Math.random().toString(16);
      bodyString = createFormDataString(boundary, body);
      headers.set("content-type", `multipart/form-data; boundary=${boundary}`);
      init.body = bodyString;
    } else if (body instanceof Blob || body instanceof ArrayBuffer) {
      bodyString = await body.text();
    } else {
      bodyString = JSON.stringify(body);
    }
  } else {
    bodyString = "";
  }

  const contentSha256 = await sha256(bodyString);
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
          typeof body === "string" ? body : JSON.stringify(body);
        const contentSha256 = await sha256(bodyString);
        this.setRequestHeader("x-amz-content-sha256", contentSha256);
      }
      this.originalSend.apply(this, [body]);
    };
  }
};
