/* eslint-disable import/no-extraneous-dependencies */
import { createHash } from "node:crypto";

function sha256(input: string | ArrayBuffer | Uint8Array) {
  const buffer =
    typeof input === "string"
      ? Buffer.from(input)
      : Buffer.from(new Uint8Array(input));
  return createHash("sha256").update(buffer).digest("hex");
}

describe("patch-fetch", () => {
  let originalFetch: jest.Mock;
  let capturedInit: RequestInit | undefined;

  beforeEach(() => {
    jest.resetModules();
    capturedInit = undefined;

    originalFetch = jest.fn((_input: unknown, init?: RequestInit) => {
      capturedInit = init;
      return Promise.resolve(new Response("ok"));
    });

    (global as any).window = {
      location: { href: "https://example.com/", hostname: "example.com" },
      fetch: originalFetch,
      XMLHttpRequest: class {
        open(_method: string, _url: string) {}
        send(_body?: unknown) {}
        setRequestHeader(_name: string, _value: string) {}
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- must re-execute against the fresh `window` stub each test
    require("./patch-fetch.js");
  });

  afterEach(() => {
    delete (global as any).window;
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
