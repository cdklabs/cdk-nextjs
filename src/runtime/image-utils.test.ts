/* eslint-disable import/no-extraneous-dependencies */
jest.mock("@aws-sdk/client-s3");

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ImageError } from "next/dist/server/image-optimizer.js";
import { getExtension } from "next/dist/server/serve-static.js";
import {
  fetchFromS3,
  getFileNameWithExtension,
  resolveErrorResponse,
} from "./image-utils";

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

/** No app `basePath`, assets at the root of the bucket: the default. */
const ROOT = { urlBasePath: "", keyPrefix: "" };

describe("fetchFromS3", () => {
  const mockSend = jest.fn();
  const s3 = new S3Client({}) as unknown as S3Client;

  beforeEach(() => {
    (s3 as unknown as { send: typeof mockSend }).send = mockSend;
    mockSend.mockReset();
  });

  const ok = () =>
    mockSend.mockResolvedValue({
      Body: asyncIterableFrom([Buffer.from("data")]),
      ContentType: "image/png",
      ETag: '"abc123"',
    });
  const keyOf = () =>
    (GetObjectCommand as unknown as jest.Mock).mock.calls[0][0].Key;

  it("strips the leading slash when the assets sit at the bucket root", async () => {
    ok();

    await fetchFromS3(s3, "my-bucket", "/static/foo.png", {
      urlBasePath: "",
      keyPrefix: "",
    });

    expect((GetObjectCommand as unknown as jest.Mock).mock.calls[0][0]).toEqual(
      { Bucket: "my-bucket", Key: "static/foo.png" },
    );
  });

  it("applies the bucket key prefix", async () => {
    ok();

    await fetchFromS3(s3, "my-bucket", "/static/foo.jpg", {
      urlBasePath: "/base",
      keyPrefix: "base",
    });

    expect(keyOf()).toBe("base/static/foo.jpg");
  });

  it("does not repeat the prefix when the url already carries basePath", async () => {
    ok();

    // next-image-loader bakes `basePath` into the href of a statically imported
    // image, unlike a plain string path.
    await fetchFromS3(s3, "my-bucket", "/base/_next/static/media/a.png", {
      urlBasePath: "/base",
      keyPrefix: "base",
    });

    expect(keyOf()).toBe("base/_next/static/media/a.png");
  });

  /**
   * The API Gateway deployment types serve the app under the stage name, so the
   * app's `basePath` is `/prod` while the assets were uploaded to the root of the
   * bucket. Building the key from `basePath` asks S3 for `prod/...`, which does
   * not exist, and every local `<Image>` 400s.
   */
  it("strips a basePath that is not part of the key", async () => {
    ok();

    await fetchFromS3(s3, "my-bucket", "/prod/_next/static/media/a.png", {
      urlBasePath: "/prod",
      keyPrefix: "",
    });

    expect(keyOf()).toBe("_next/static/media/a.png");
  });

  it("leaves a url without basePath alone when there is no key prefix", async () => {
    ok();

    await fetchFromS3(s3, "my-bucket", "/static/foo.jpg", {
      urlBasePath: "/prod",
      keyPrefix: "",
    });

    expect(keyOf()).toBe("static/foo.jpg");
  });

  it("only matches basePath on a path boundary", async () => {
    ok();

    await fetchFromS3(s3, "my-bucket", "/basement/logo.png", {
      urlBasePath: "/base",
      keyPrefix: "base",
    });

    expect(keyOf()).toBe("base/basement/logo.png");
  });

  it("returns the concatenated buffer, content type, and etag", async () => {
    mockSend.mockResolvedValue({
      Body: asyncIterableFrom([Buffer.from("hel"), Buffer.from("lo")]),
      ContentType: "image/jpeg",
      ETag: '"the-etag"',
    });

    const result = await fetchFromS3(s3, "my-bucket", "/foo.jpg", ROOT);

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

    const result = await fetchFromS3(s3, "my-bucket", "/foo.png", ROOT);

    expect(result.etag).toBe("");
    expect(result.contentType).toBeNull();
  });

  it("throws when S3 returns no body", async () => {
    mockSend.mockResolvedValue({ Body: undefined });

    await expect(
      fetchFromS3(s3, "my-bucket", "/missing.png", ROOT),
    ).rejects.toThrow(/Empty response from S3/);
  });
});

describe("getFileNameWithExtension", () => {
  it("derives filename and extension from the url and content type", () => {
    expect(
      getFileNameWithExtension(
        "/foo/bar.png?w=100&q=75",
        "image/webp",
        getExtension,
      ),
    ).toBe("bar.webp");
  });

  it("falls back to image.bin when contentType is missing", () => {
    expect(getFileNameWithExtension("/foo/bar.png", null, getExtension)).toBe(
      "image.bin",
    );
  });

  it("falls back to image.bin when the url has no filename segment", () => {
    expect(getFileNameWithExtension("/", "image/png", getExtension)).toBe(
      "image.bin",
    );
  });
});

describe("resolveErrorResponse", () => {
  it("preserves the status code and message from an ImageError", () => {
    const error = new ImageError(400, '"url" parameter is not allowed');

    expect(resolveErrorResponse(error, ImageError)).toEqual({
      statusCode: 400,
      message: '"url" parameter is not allowed',
    });
  });

  it("maps a missing S3 object to the same 400 Next.js's own local-image fetch produces", () => {
    const error = new Error("NoSuchKey: does not exist");
    error.name = "NoSuchKey";

    expect(resolveErrorResponse(error, ImageError)).toEqual({
      statusCode: 400,
      message: "The requested resource isn't a valid image.",
    });
  });

  it("falls back to 500 for unrecognized errors", () => {
    expect(resolveErrorResponse(new Error("boom"), ImageError)).toEqual({
      statusCode: 500,
      message: "Internal Server Error",
    });
    expect(resolveErrorResponse("not an error", ImageError)).toEqual({
      statusCode: 500,
      message: "Internal Server Error",
    });
  });
});
