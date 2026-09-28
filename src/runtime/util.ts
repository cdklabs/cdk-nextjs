/* eslint-disable import/no-extraneous-dependencies */
/** Small helpers more than one runtime module needs. */
import { S3Client } from "@aws-sdk/client-s3";
import type { ShimServerResponse } from "./http/response";
import { hasPathPrefix } from "../utils/base-path";

/** The first of a repeated header, or the header. */
export function firstValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `removePathPrefix` (`next/dist/shared/lib/router/utils/remove-path-prefix.js`):
 * strips `prefix` on a path boundary only, so `/docsearch` is not under `/docs`.
 * An absolute-URL `assetPrefix` never matches a pathname, so it is a no-op
 * there, as it is in Next.
 */
export function withoutPathPrefix(pathname: string, prefix: string): string {
  if (!hasPathPrefix(pathname, prefix)) {
    return pathname;
  }
  return pathname.slice(prefix.length) || "/";
}

/**
 * A query back into a query string, repeats and all. A key with no value — an
 * optional catch-all the request left unset — is left out rather than sent as
 * `undefined`.
 */
export function toSearch(
  query: Readonly<Record<string, string | string[] | undefined>>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) search.append(key, item);
    }
  }
  return search.toString();
}

/** An already-closed stream: a request body with nothing in it. */
export function emptyStream(): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/** Resolves `true` on `drain`, `false` if the response closes first. */
export function drained(res: ShimServerResponse): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onDrain = (): void => settle(true);
    const onClose = (): void => settle(false);
    const settle = (value: boolean): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      resolve(value);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

let s3: S3Client | undefined;

/** The one S3 client, for the image optimizer and `public/` files alike. */
export function s3Client(): S3Client {
  s3 ??= new S3Client({});
  return s3;
}
