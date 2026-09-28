/* eslint-disable import/no-extraneous-dependencies */
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { ShimIncomingMessage } from "./http/request";
import { ShimServerResponse } from "./http/response";
import { serveS3PublicFile } from "./static-files";

const send$ = jest.spyOn(S3Client.prototype, "send");
afterEach(() => send$.mockReset());
afterAll(() => send$.mockRestore());

const FILE = { bucket: "assets", keyPrefix: "", file: "big.bin", etag: true };

function serve(
  method: string,
  res = new ShimServerResponse(),
  headers: Record<string, string> = {},
  file = FILE,
) {
  const req = new ShimIncomingMessage({ method, url: "/big.bin", headers });
  return { res, served: serveS3PublicFile(req, res, file) };
}

/** Chunks bigger than the response's buffer, so every write is refused. */
const CHUNK = Buffer.alloc(64 * 1024, "a");

describe("serveS3PublicFile", () => {
  it("asks S3 for the head alone for a HEAD, and sends no body", async () => {
    send$.mockImplementation((async () => ({
      ContentType: "application/octet-stream",
      ContentLength: 3,
      ETag: '"e1"',
    })) as never);
    const { res, served } = serve("HEAD");
    const chunks: Buffer[] = [];
    res.on("data", (chunk: Buffer) => chunks.push(chunk));
    expect(await served).toBe(true);
    expect(send$.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(res.getHeader("Content-Length")).toBe("3");
    expect(res.getHeader("ETag")).toBe('"e1"');
    expect(res.writableEnded).toBe(true);
    expect(Buffer.concat(chunks).length).toBe(0);
  });

  // `generateEtags: false`: no ETag to revalidate with, only Last-Modified.
  it("answers If-Modified-Since with a 304, as send does", async () => {
    send$.mockImplementation((async () => {
      throw Object.assign(new Error("Not Modified"), {
        $metadata: { httpStatusCode: 304 },
      });
    }) as never);
    const since = "Wed, 21 Oct 2015 07:28:00 GMT";
    const { res, served } = serve(
      "GET",
      undefined,
      { "if-modified-since": since },
      { ...FILE, etag: false },
    );
    expect(await served).toBe(true);
    expect(res.statusCode).toBe(304);
    const input = (send$.mock.calls[0][0] as GetObjectCommand).input;
    expect(input.IfModifiedSince).toEqual(new Date(since));
    expect(input.IfNoneMatch).toBeUndefined();
  });

  // `fresh` ignores If-Modified-Since next to an If-None-Match.
  it("leaves If-Modified-Since out next to an If-None-Match", async () => {
    send$.mockImplementation((async () => ({})) as never);
    await serve("HEAD", undefined, {
      "if-none-match": '"e1"',
      "if-modified-since": "Wed, 21 Oct 2015 07:28:00 GMT",
    }).served;
    const input = (send$.mock.calls[0][0] as HeadObjectCommand).input;
    expect(input.IfNoneMatch).toBe('"e1"');
    expect(input.IfModifiedSince).toBeUndefined();
  });

  it("rethrows an S3 error that is not a missing object", async () => {
    send$.mockImplementation((async () => {
      throw Object.assign(new Error("Access Denied"), {
        name: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      });
    }) as never);
    await expect(serve("GET").served).rejects.toThrow("Access Denied");
  });

  it("waits for the client to drain before reading more of the object", async () => {
    send$.mockImplementation((async () => ({
      Body: Readable.from([CHUNK, CHUNK, CHUNK]),
    })) as never);
    const { res, served } = serve("GET");
    expect(send$.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    // Nothing reads the response yet, so the first write is refused and the
    // rest of the object waits.
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.writableEnded).toBe(false);

    let received = 0;
    res.on("data", (chunk: Buffer) => (received += chunk.length));
    expect(await served).toBe(true);
    expect(res.writableEnded).toBe(true);
    await new Promise((resolve) => res.once("end", resolve));
    expect(received).toBe(3 * CHUNK.length);
  });

  it("stops reading the object when the client disconnects", async () => {
    const body = Readable.from([CHUNK, CHUNK, CHUNK]);
    send$.mockImplementation((async () => ({ Body: body })) as never);
    const { res, served } = serve("GET");
    await new Promise((resolve) => setImmediate(resolve));
    res.destroy();
    expect(await served).toBe(true);
    expect(res.writableEnded).toBe(false);
    // Destroyed, which is what releases the S3 connection.
    expect(body.destroyed).toBe(true);
  });
});
