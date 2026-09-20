/* eslint-disable import/no-extraneous-dependencies */
jest.mock("@aws-sdk/client-s3");

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ImageError } from "next/dist/server/image-optimizer.js";
import {
  fetchFromS3,
  getFileNameWithExtension,
  resolveErrorResponse,
} from "./handler-utils";

function asyncIterableFrom(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async () =>
          i < chunks.length
            ? { done: false, value: chunks[i++] }
            : { done: true, value: undefined },
      };
    },
  };
}

describe("fetchFromS3", () => {
  const mockSend = jest.fn();
  const s3 = new S3Client({}) as unknown as S3Client;

  beforeEach(() => {
    (s3 as unknown as { send: typeof mockSend }).send = mockSend;
    mockSend.mockReset();
  });

  it("strips the leading slash and uses url as-is for the S3 key", async () => {
    mockSend.mockResolvedValue({
      Body: asyncIterableFrom([Buffer.from("data")]),
      ContentType: "image/png",
      ETag: '"abc123"',
    });

    await fetchFromS3(s3, "my-bucket", "/base/foo.png", "");

    const params = (GetObjectCommand as unknown as jest.Mock).mock.calls[0][0];
    expect(params).toEqual({
      Bucket: "my-bucket",
      Key: "base/foo.png",
    });
  });

  it("keeps a single basePath prefix when the url already includes it", async () => {
    mockSend.mockResolvedValue({
      Body: asyncIterableFrom([Buffer.from("data")]),
      ContentType: "image/png",
      ETag: '"abc123"',
    });

    // next-image-loader bakes "/base" into the href for statically imported
    // images, and NextjsStaticAssets uploads under the same prefix, so the
    // key must carry it exactly once.
    await fetchFromS3(
      s3,
      "my-bucket",
      "/base/_next/static/media/a.png",
      "/base",
    );

    const params = (GetObjectCommand as unknown as jest.Mock).mock.calls[0][0];
    expect(params.Key).toBe("base/_next/static/media/a.png");
  });

  it("adds the basePath prefix when the url omits it", async () => {
    mockSend.mockResolvedValue({
      Body: asyncIterableFrom([Buffer.from("data")]),
      ContentType: "image/png",
      ETag: '"abc123"',
    });

    // Plain string paths (e.g. `<Image src="/static/foo.jpg">`) are passed
    // through by next/image as written, without basePath baked in, but the
    // S3 key still has it.
    await fetchFromS3(s3, "my-bucket", "/static/foo.jpg", "/base");

    const params = (GetObjectCommand as unknown as jest.Mock).mock.calls[0][0];
    expect(params.Key).toBe("base/static/foo.jpg");
  });

  it("only matches basePath on a path boundary", async () => {
    mockSend.mockResolvedValue({
      Body: asyncIterableFrom([Buffer.from("data")]),
      ContentType: "image/png",
      ETag: '"abc123"',
    });

    // "/basement" merely shares a prefix with basePath "/base"; treating it
    // as a match would produce the key "base/ment/logo.png".
    await fetchFromS3(s3, "my-bucket", "/basement/logo.png", "/base");

    const params = (GetObjectCommand as unknown as jest.Mock).mock.calls[0][0];
    expect(params.Key).toBe("base/basement/logo.png");
  });

  it("returns the concatenated buffer, content type, and etag", async () => {
    mockSend.mockResolvedValue({
      Body: asyncIterableFrom([Buffer.from("hel"), Buffer.from("lo")]),
      ContentType: "image/jpeg",
      ETag: '"the-etag"',
    });

    const result = await fetchFromS3(s3, "my-bucket", "/foo.jpg", "");

    expect(result.buffer.toString()).toBe("hello");
    expect(result.contentType).toBe("image/jpeg");
    expect(result.etag).toBe('"the-etag"');
  });

  it("returns an empty etag when S3 doesn't provide one", async () => {
    mockSend.mockResolvedValue({
      Body: asyncIterableFrom([Buffer.from("data")]),
      ContentType: null,
      ETag: undefined,
    });

    const result = await fetchFromS3(s3, "my-bucket", "/foo.png", "");

    expect(result.etag).toBe("");
    expect(result.contentType).toBeNull();
  });

  it("throws when S3 returns no body", async () => {
    mockSend.mockResolvedValue({ Body: undefined });

    await expect(
      fetchFromS3(s3, "my-bucket", "/missing.png", ""),
    ).rejects.toThrow(/Empty response from S3/);
  });
});

describe("getFileNameWithExtension", () => {
  it("derives filename and extension from the url and content type", () => {
    expect(
      getFileNameWithExtension("/foo/bar.png?w=100&q=75", "image/webp"),
    ).toBe("bar.webp");
  });

  it("falls back to image.bin when contentType is missing", () => {
    expect(getFileNameWithExtension("/foo/bar.png", null)).toBe("image.bin");
  });

  it("falls back to image.bin when the url has no filename segment", () => {
    expect(getFileNameWithExtension("/", "image/png")).toBe("image.bin");
  });
});

describe("resolveErrorResponse", () => {
  it("preserves the status code and message from an ImageError", () => {
    const error = new ImageError(400, '"url" parameter is not allowed');

    expect(resolveErrorResponse(error)).toEqual({
      statusCode: 400,
      message: '"url" parameter is not allowed',
    });
  });

  it("maps a missing S3 object to the same 400 Next.js's own local-image fetch produces", () => {
    const error = new Error("NoSuchKey: does not exist");
    error.name = "NoSuchKey";

    expect(resolveErrorResponse(error)).toEqual({
      statusCode: 400,
      message: "The requested resource isn't a valid image.",
    });
  });

  it("falls back to 500 for unrecognized errors", () => {
    expect(resolveErrorResponse(new Error("boom"))).toEqual({
      statusCode: 500,
      message: "Internal Server Error",
    });
    expect(resolveErrorResponse("not an error")).toEqual({
      statusCode: 500,
      message: "Internal Server Error",
    });
  });
});
