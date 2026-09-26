/* eslint-disable import/no-extraneous-dependencies */
jest.mock("@aws-sdk/client-s3");
// The real module, with the one step that needs `sharp` stubbed out: these tests
// are about the response `handle` writes, not about optimizing an image.
jest.mock("next/dist/server/image-optimizer.js", () => ({
  ...jest.requireActual("next/dist/server/image-optimizer.js"),
  imageOptimizer: jest.fn(),
}));

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { validateHeaderValue } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { imageOptimizer } from "next/dist/server/image-optimizer.js";
import { imageConfigDefault } from "next/dist/shared/lib/image-config.js";
import { createIncomingMessage } from "./http/request";
import { ResponseHead, ShimServerResponse } from "./http/response";
import { pipeToSink } from "./http/sink";
import { RuntimeImageOptimizer } from "./image";
import { AdapterManifest } from "./manifest";
import { useNextFrom } from "./next-modules";

const PNG = Buffer.from("optimized-bytes");
const ETAG = "abc123";

/** Just what `loadImageRuntime` reads: where `required-server-files.json` is. */
function stage(): string {
  const root = mkdtempSync(join(tmpdir(), "cdk-nextjs-image-"));
  mkdirSync(join(root, ".next"));
  writeFileSync(
    join(root, ".next/required-server-files.json"),
    JSON.stringify({
      config: {
        basePath: "",
        experimental: {},
        images: { ...imageConfigDefault, localPatterns: undefined },
      },
    }),
  );
  return root;
}

let optimizer: RuntimeImageOptimizer;

beforeAll(() => {
  useNextFrom(join(__dirname, "../.."));
  optimizer = new RuntimeImageOptimizer({
    deploymentRoot: stage(),
    manifest: {
      relativeProjectDir: "",
      config: { distDir: ".next" },
    } as unknown as AdapterManifest,
    bucket: "assets",
    bucketKeyPrefix: "",
  });
  (optimizer as unknown as { s3: S3Client }).s3 = {
    send: async () => ({
      Body: [Buffer.from("upstream-bytes")],
      ContentType: "image/png",
      ETag: '"upstream"',
    }),
  } as unknown as S3Client;
});

beforeEach(() => {
  (imageOptimizer as jest.Mock).mockResolvedValue({
    buffer: PNG,
    contentType: "image/webp",
    maxAge: 60,
    etag: ETAG,
  });
});

interface Answer {
  readonly head: ResponseHead;
  readonly body: string;
}

async function request(
  src: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const url = new URL(
    `https://shop.example.test/_next/image?url=${encodeURIComponent(src)}&w=640&q=75`,
  );
  const req = createIncomingMessage({
    method: init.method ?? "GET",
    url: `${url.pathname}${url.search}`,
    headers: { accept: "image/webp", ...init.headers },
  });
  const res = new ShimServerResponse();
  let head: ResponseHead | undefined;
  const chunks: Buffer[] = [];
  const done = pipeToSink(
    req,
    res,
    {
      begin(responseHead) {
        head = responseHead;
        return new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
        });
      },
    },
    { compress: false },
  );
  await optimizer.handle(req, res, url);
  await done;
  return { head: head!, body: Buffer.concat(chunks).toString() };
}

describe("RuntimeImageOptimizer response", () => {
  it("answers with the headers next start sends", async () => {
    const { head, body } = await request("/photos/logo.png");
    expect(head.statusCode).toBe(200);
    expect(head.headers).toMatchObject({
      "cache-control": "public, max-age=60, must-revalidate",
      "content-type": "image/webp",
      "content-length": String(PNG.length),
      "content-disposition": 'attachment; filename="logo.webp"',
      "content-security-policy": imageConfigDefault.contentSecurityPolicy,
      etag: ETAG,
      vary: "Accept",
      "x-nextjs-cache": "MISS",
    });
    expect(body).toBe(PNG.toString());
  });

  // Content-hashed, so the name changes whenever the bytes do.
  it("caches a statically imported image for a year, immutable", async () => {
    const { head } = await request("/_next/static/media/logo.3f2a1c.png");
    expect(head.headers["cache-control"]).toBe(
      "public, max-age=315360000, immutable",
    );
  });

  // `writeHead` rejects a header value outside latin1 with ERR_INVALID_CHAR,
  // and the Lambda sink writes the head through it.
  it("encodes a non-latin1 filename rather than sending it raw", async () => {
    const { head } = await request("/ümlaut-写真.png");
    const disposition = head.headers["content-disposition"];
    expect(disposition).toMatch(/^attachment; filename="[^"]*"; filename\*=/);
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent("ümlaut-写真.webp")}`,
    );
    expect(() =>
      validateHeaderValue("Content-Disposition", disposition),
    ).not.toThrow();
  });

  it.each([
    ["the exact tag", ETAG],
    ["a weak form of it", `W/${ETAG}`],
    ["a list containing it", `"other", ${ETAG}`],
    ["a wildcard", "*"],
  ])("answers 304 to If-None-Match with %s", async (_name, ifNoneMatch) => {
    const { head, body } = await request("/logo.png", {
      headers: { "if-none-match": ifNoneMatch },
    });
    expect(head.statusCode).toBe(304);
    expect(head.headers.etag).toBe(ETAG);
    expect(head.headers["cache-control"]).toBe(
      "public, max-age=60, must-revalidate",
    );
    expect(body).toBe("");
  });

  it("answers 200 to an If-None-Match that does not match", async () => {
    const { head } = await request("/logo.png", {
      headers: { "if-none-match": '"other"' },
    });
    expect(head.statusCode).toBe(200);
  });

  it("sends the headers but no body to HEAD", async () => {
    const { head, body } = await request("/logo.png", { method: "HEAD" });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe(String(PNG.length));
    expect(body).toBe("");
  });
});
