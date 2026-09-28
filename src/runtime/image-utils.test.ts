/* eslint-disable import/no-extraneous-dependencies */
jest.mock("@aws-sdk/client-s3");

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ImageError } from "next/dist/server/image-optimizer.js";
import {
  fetchFromS3,
  ImageTooLargeError,
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

    await fetchFromS3(
      s3,
      "my-bucket",
      "/static/foo.png",
      {
        urlBasePath: "",
        keyPrefix: "",
      },
      Infinity,
    );

    expect((GetObjectCommand as unknown as jest.Mock).mock.calls[0][0]).toEqual(
      { Bucket: "my-bucket", Key: "static/foo.png" },
    );
  });

  it("applies the bucket key prefix", async () => {
    ok();

    await fetchFromS3(
      s3,
      "my-bucket",
      "/static/foo.jpg",
      {
        urlBasePath: "/base",
        keyPrefix: "base",
      },
      Infinity,
    );

    expect(keyOf()).toBe("base/static/foo.jpg");
  });

  it("does not repeat the prefix when the url already carries basePath", async () => {
    ok();

    // next-image-loader bakes `basePath` into the href of a statically imported
    // image, unlike a plain string path.
    await fetchFromS3(
      s3,
      "my-bucket",
      "/base/_next/static/media/a.png",
      {
        urlBasePath: "/base",
        keyPrefix: "base",
      },
      Infinity,
    );

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

    await fetchFromS3(
      s3,
      "my-bucket",
      "/prod/_next/static/media/a.png",
      {
        urlBasePath: "/prod",
        keyPrefix: "",
      },
      Infinity,
    );

    expect(keyOf()).toBe("_next/static/media/a.png");
  });

  it("leaves a url without basePath alone when there is no key prefix", async () => {
    ok();

    await fetchFromS3(
      s3,
      "my-bucket",
      "/static/foo.jpg",
      {
        urlBasePath: "/prod",
        keyPrefix: "",
      },
      Infinity,
    );

    expect(keyOf()).toBe("static/foo.jpg");
  });

  // With `assetPrefix: "/cdn"`, a static import's href is
  // `/cdn/_next/static/media/…`, with `basePath` nowhere in it.
  it("strips a path assetPrefix in front of /_next/", async () => {
    ok();

    await fetchFromS3(
      s3,
      "my-bucket",
      "/cdn/_next/static/media/a.png",
      {
        urlBasePath: "/base",
        keyPrefix: "",
        assetPrefix: "/cdn/",
      },
      Infinity,
    );

    expect(keyOf()).toBe("_next/static/media/a.png");
  });

  it("leaves a public/ file under a directory named like the assetPrefix alone", async () => {
    ok();

    await fetchFromS3(
      s3,
      "my-bucket",
      "/cdn/logo.png",
      {
        urlBasePath: "",
        keyPrefix: "",
        assetPrefix: "/cdn",
      },
      Infinity,
    );

    expect(keyOf()).toBe("cdn/logo.png");
  });

  it("ignores an absolute assetPrefix", async () => {
    ok();

    await fetchFromS3(
      s3,
      "my-bucket",
      "/_next/static/media/a.png",
      {
        urlBasePath: "",
        keyPrefix: "",
        assetPrefix: "https://cdn.example.test",
      },
      Infinity,
    );

    expect(keyOf()).toBe("_next/static/media/a.png");
  });

  it("only matches basePath on a path boundary", async () => {
    ok();

    await fetchFromS3(
      s3,
      "my-bucket",
      "/basement/logo.png",
      {
        urlBasePath: "/base",
        keyPrefix: "base",
      },
      Infinity,
    );

    expect(keyOf()).toBe("base/basement/logo.png");
  });

  // Carried over from #267, which fixed the same bug in the pre-adapter image
  // handler: a `destinationKeyPrefix` override can arrive with a trailing slash.
  it("doesn't double the separator when the key prefix has a trailing slash", async () => {
    ok();

    await fetchFromS3(
      s3,
      "my-bucket",
      "/static/foo.jpg",
      {
        urlBasePath: "",
        keyPrefix: "base/",
      },
      Infinity,
    );

    expect(keyOf()).toBe("base/static/foo.jpg");
  });

  // `next-image-legacy/unicode`, whose `public/` holds both of these names. The
  // space is what broke: the key is the file's real name, the url is a URL path.
  it.each([
    ["/hello%20world.jpg", "hello world.jpg"],
    ["/äöüščří.png", "äöüščří.png"],
    ["/%C3%A4%C3%B6.png", "äö.png"],
  ])("decodes %s into the object's real name", async (url, key) => {
    ok();

    await fetchFromS3(s3, "my-bucket", url, ROOT, Infinity);

    expect(keyOf()).toBe(key);
  });

  // A cache-buster on a local src: `next start` routes the href as a request, so
  // the query and fragment never reach the file lookup.
  it.each([
    ["/logo.png?v=2", "logo.png"],
    ["/logo.png#top", "logo.png"],
    ["/logo.png?v=2#top", "logo.png"],
    ["/base/logo.png?v=2", "logo.png"],
    // A `?` that is part of the name arrives encoded and is not a query.
    ["/what%3F.png?v=2", "what?.png"],
  ])("keys %s by its path alone", async (url, key) => {
    ok();

    await fetchFromS3(
      s3,
      "my-bucket",
      url,
      {
        urlBasePath: "/base",
        keyPrefix: "",
      },
      Infinity,
    );

    expect(keyOf()).toBe(key);
  });

  it("leaves a name that isn't valid percent-encoding alone", async () => {
    ok();

    await fetchFromS3(s3, "my-bucket", "/100%.png", ROOT, Infinity);

    expect(keyOf()).toBe("100%.png");
  });

  it("returns the concatenated buffer, content type, and etag", async () => {
    mockSend.mockResolvedValue({
      Body: asyncIterableFrom([Buffer.from("hel"), Buffer.from("lo")]),
      ContentType: "image/jpeg",
      ETag: '"the-etag"',
    });

    const result = await fetchFromS3(
      s3,
      "my-bucket",
      "/foo.jpg",
      ROOT,
      Infinity,
    );

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

    const result = await fetchFromS3(
      s3,
      "my-bucket",
      "/foo.png",
      ROOT,
      Infinity,
    );

    expect(result.etag).toBe("");
    expect(result.contentType).toBeNull();
  });

  // `images.maximumResponseBody`, which `next start` enforces on local sources.
  it("refuses an object whose ContentLength is over the limit, unread", async () => {
    const destroy = jest.fn();
    mockSend.mockResolvedValue({
      Body: { ...asyncIterableFrom([Buffer.from("never read")]), destroy },
      ContentLength: 11,
    });

    await expect(
      fetchFromS3(s3, "my-bucket", "/big.png", ROOT, 10),
    ).rejects.toBeInstanceOf(ImageTooLargeError);
    expect(destroy).toHaveBeenCalled();
  });

  it("stops reading once the bytes read pass the limit", async () => {
    mockSend.mockResolvedValue({
      Body: asyncIterableFrom([Buffer.from("hel"), Buffer.from("lo")]),
    });

    await expect(
      fetchFromS3(s3, "my-bucket", "/big.png", ROOT, 4),
    ).rejects.toBeInstanceOf(ImageTooLargeError);
    // At the limit exactly is fine.
    mockSend.mockResolvedValue({
      Body: asyncIterableFrom([Buffer.from("hel"), Buffer.from("lo")]),
      ContentLength: 5,
    });
    const result = await fetchFromS3(s3, "my-bucket", "/ok.png", ROOT, 5);
    expect(result.buffer.toString()).toBe("hello");
  });

  it("throws when S3 returns no body", async () => {
    mockSend.mockResolvedValue({ Body: undefined });

    await expect(
      fetchFromS3(s3, "my-bucket", "/missing.png", ROOT, Infinity),
    ).rejects.toThrow(/Empty response from S3/);
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

  it("maps a source over images.maximumResponseBody to next start's 413", () => {
    expect(
      resolveErrorResponse(new ImageTooLargeError("big.png"), ImageError),
    ).toEqual({
      statusCode: 413,
      message: '"url" parameter is valid but internal response is invalid',
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
