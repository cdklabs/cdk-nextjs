/* eslint-disable import/no-extraneous-dependencies */
import { createHash } from "node:crypto";

function sha256(input: string | ArrayBuffer | Uint8Array) {
  const buffer =
    typeof input === "string"
      ? Buffer.from(input)
      : Buffer.from(new Uint8Array(input));
  return createHash("sha256").update(buffer).digest("hex");
}

class FakeXMLHttpRequest {
  open(_method: string, _url: string) {}
  send(_body?: unknown) {}
  setRequestHeader(_name: string, _value: string) {}
}

/**
 * The patch runs in a browser *and* in a web worker, where `window` does not
 * exist — so the stub goes on `globalThis`, which is what both scopes are. Tests
 * that want the main-thread scope also set `globalThis.window`, since real
 * browser code reaches the patched `fetch` through it and `window === globalThis`
 * there.
 */
function installScope({ withWindow = true, withXhr = true } = {}) {
  (global as any).location = {
    href: "https://example.com/",
    hostname: "example.com",
  };
  if (withXhr) (global as any).XMLHttpRequest = FakeXMLHttpRequest;
  if (withWindow) (global as any).window = global;
}

describe("patch-fetch", () => {
  let originalFetch: jest.Mock;
  let capturedInit: RequestInit | undefined;
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    capturedInit = undefined;

    originalFetch = jest.fn((_input: unknown, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response("ok"));
    });
    (global as any).fetch = originalFetch;

    installScope();

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- must re-execute against the fresh global stub each test
    require("./patch-fetch.js");
  });

  afterEach(() => {
    delete (global as any).window;
    delete (global as any).location;
    delete (global as any).XMLHttpRequest;
    global.fetch = realFetch;
  });

  describe("fetch", () => {
    test("hashes URLSearchParams via toString(), not JSON.stringify", async () => {
      const params = new URLSearchParams({ a: "1", b: "2" });

      await (global as any).window.fetch("https://example.com/api", {
        method: "POST",
        body: params,
      });

      const headers = capturedInit!.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(
        sha256(params.toString()),
      );
      expect(headers.get("x-amz-content-sha256")).not.toBe(sha256("{}"));
    });

    test("hashes a plain string body", async () => {
      await (global as any).window.fetch("https://example.com/api", {
        method: "POST",
        body: "raw text body",
      });

      const headers = capturedInit!.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(sha256("raw text body"));
    });

    test("hashes a FormData body over its exact encoded bytes and sets content-type", async () => {
      const formData = new FormData();
      formData.append("field", "value");
      formData.append(
        "file",
        new Blob(["file contents"], { type: "text/plain" }),
        "file.txt",
      );

      await (global as any).window.fetch("https://example.com/api", {
        method: "POST",
        body: formData,
      });

      // the body sent to the real fetch must be the re-encoded bytes, not the original FormData
      const sentBytes = capturedInit!.body as Uint8Array;
      expect(sentBytes).toBeInstanceOf(Uint8Array);

      const headers = capturedInit!.headers as Headers;
      const contentType = headers.get("content-type")!;
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(headers.get("x-amz-content-sha256")).toBe(sha256(sentBytes));

      // the hashed/sent bytes must round-trip back to the original fields
      const roundTripped = await new Response(sentBytes, {
        headers: { "content-type": contentType },
      }).formData();
      expect(roundTripped.get("field")).toBe("value");
      const file = roundTripped.get("file") as File;
      expect(file.name).toBe("file.txt");
      expect(await file.text()).toBe("file contents");
    });

    test("hashes a Blob body over its raw bytes", async () => {
      const blob = new Blob(["blob contents"], { type: "text/plain" });

      await (global as any).window.fetch("https://example.com/api", {
        method: "POST",
        body: blob,
      });

      const headers = capturedInit!.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(
        sha256(await blob.arrayBuffer()),
      );
    });

    test("hashes an ArrayBuffer body over its raw bytes", async () => {
      const buffer = new TextEncoder().encode("array buffer contents").buffer;

      await (global as any).window.fetch("https://example.com/api", {
        method: "PUT",
        body: buffer,
      });

      const headers = capturedInit!.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(sha256(buffer));
    });

    test("hashes an empty byte array when no body is present", async () => {
      await (global as any).window.fetch("https://example.com/api", {
        method: "POST",
      });

      const headers = capturedInit!.headers as Headers;
      expect(headers.get("x-amz-content-sha256")).toBe(
        sha256(new Uint8Array(0)),
      );
    });

    test("passes through untouched when init is omitted", async () => {
      await (global as any).window.fetch("https://example.com/api");

      expect(originalFetch).toHaveBeenCalledWith(
        "https://example.com/api",
        undefined,
      );
    });

    test("passes through without hashing for non-PUT/POST methods", async () => {
      await (global as any).window.fetch("https://example.com/api", {
        method: "GET",
        body: "should not be hashed",
      });

      expect(capturedInit!.headers).toBeUndefined();
    });

    test("passes through without hashing for cross-origin requests", async () => {
      await (global as any).window.fetch("https://other-origin.com/api", {
        method: "POST",
        body: "should not be hashed",
      });

      expect(capturedInit!.headers).toBeUndefined();
    });
  });

  describe("XMLHttpRequest", () => {
    test("hashes URLSearchParams via toString(), not JSON.stringify", async () => {
      const params = new URLSearchParams({ a: "1", b: "2" });
      const setRequestHeader = jest.fn();

      const xhr = new (global as any).window.XMLHttpRequest();
      xhr.setRequestHeader = setRequestHeader;
      xhr.open("POST", "https://example.com/api");
      await xhr.send(params);

      expect(setRequestHeader).toHaveBeenCalledWith(
        "x-amz-content-sha256",
        sha256(params.toString()),
      );
      expect(setRequestHeader).not.toHaveBeenCalledWith(
        "x-amz-content-sha256",
        sha256("{}"),
      );
    });

    test("hashes a plain string body", async () => {
      const setRequestHeader = jest.fn();

      const xhr = new (global as any).window.XMLHttpRequest();
      xhr.setRequestHeader = setRequestHeader;
      xhr.open("PUT", "https://example.com/api");
      await xhr.send("raw text body");

      expect(setRequestHeader).toHaveBeenCalledWith(
        "x-amz-content-sha256",
        sha256("raw text body"),
      );
    });

    test("does not hash for non-PUT/POST methods", async () => {
      const setRequestHeader = jest.fn();

      const xhr = new (global as any).window.XMLHttpRequest();
      xhr.setRequestHeader = setRequestHeader;
      xhr.open("GET", "https://example.com/api");
      await xhr.send("should not be hashed");

      expect(setRequestHeader).not.toHaveBeenCalled();
    });

    test("does not hash for cross-origin requests", async () => {
      const setRequestHeader = jest.fn();

      const xhr = new (global as any).window.XMLHttpRequest();
      xhr.setRequestHeader = setRequestHeader;
      xhr.open("POST", "https://other-origin.com/api");
      await xhr.send("should not be hashed");

      expect(setRequestHeader).not.toHaveBeenCalled();
    });

    test("does not hash when there is no body", async () => {
      const setRequestHeader = jest.fn();

      const xhr = new (global as any).window.XMLHttpRequest();
      xhr.setRequestHeader = setRequestHeader;
      xhr.open("POST", "https://example.com/api");
      await xhr.send();

      expect(setRequestHeader).not.toHaveBeenCalled();
    });
  });
});

/**
 * Turbopack's web-worker bootstrap is `static/chunks/turbopack-worker-*.js`,
 * which `patchFetchInClientJs`'s `turbopack-` selector matches — so this file is
 * prepended to a script that runs off the main thread. Reading `window` there
 * threw before the worker's own module could run, which took out every
 * `new Worker(new URL(…))` app (`worker-module-url`, `worker-relay-compiler`).
 */
describe("patch-fetch in a worker scope", () => {
  let originalFetch: jest.Mock;
  let capturedInit: RequestInit | undefined;
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    capturedInit = undefined;
    originalFetch = jest.fn((_input: unknown, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response("ok"));
    });
    (global as any).fetch = originalFetch;
    // No `window`, and no `XMLHttpRequest`: the narrowest scope the patch can
    // land in.
    installScope({ withWindow: false, withXhr: false });
  });

  afterEach(() => {
    delete (global as any).window;
    delete (global as any).location;
    global.fetch = realFetch;
  });

  test("loads without a window and still signs a same-origin POST", async () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- the point of the test is that requiring it does not throw
      require("./patch-fetch.js");
    }).not.toThrow();

    await global.fetch("https://example.com/api", {
      method: "POST",
      body: "worker body",
    });

    const headers = capturedInit!.headers as Headers;
    expect(headers.get("x-amz-content-sha256")).toBe(sha256("worker body"));
  });

  test("leaves XMLHttpRequest alone when the scope has none", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-executed against this scope
    require("./patch-fetch.js");

    expect((global as any).XMLHttpRequest).toBeUndefined();
  });
});
