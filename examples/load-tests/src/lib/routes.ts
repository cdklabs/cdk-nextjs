import http from "k6/http";
import { BASE_URL, COOKIE, ORIGIN } from "./config.ts";

/**
 * What each request kind exercises, against the bench app (examples/bench-app).
 * On the Global constructs, `static-asset`, `static` and `image` are CloudFront
 * cache hits after the first request, and `isr` is one until its 10 s revalidate
 * lapses. Everything else reaches compute every time. The Regional constructs
 * have no CDN, so every kind reaches compute (or API Gateway's S3 integration
 * for static assets on NextjsRegionalFunctions).
 */
export const KINDS = [
  "static-asset",
  "static",
  "isr",
  "ssr",
  "stream",
  "rsc",
  "api",
  "image",
] as const;

export type Kind = (typeof KINDS)[number];

export interface Target {
  url: string;
  headers?: Record<string, string>;
}

export type Targets = Record<Kind, Target>;

/** Only the kinds whose latency is the construct's compute, not a CDN or S3. */
export const COMPUTE_KINDS: Kind[] = ["ssr", "stream", "rsc", "api"];

export function parseKinds(values: string[]): Kind[] {
  for (const value of values) {
    if (!(KINDS as readonly string[]).includes(value)) {
      throw new Error(`Unknown kind "${value}". Expected one of ${KINDS.join(", ")}`);
    }
  }
  return values as Kind[];
}

/**
 * Resolves every kind to a URL, discovering the hashed asset URLs from the
 * pages that reference them. Runs in `setup()`, so it also fails the run early
 * if the deployment is not serving the bench app.
 */
export function discoverTargets(): Targets {
  const staticPage = getText(`${BASE_URL}/static`);
  const chunk = /["'](\/(?:[^"']*\/)?_next\/static\/chunks\/[^"']+\.js)["']/.exec(staticPage);
  if (!chunk) throw new Error("No /_next/static chunk referenced by /static");

  const imagePage = getText(`${BASE_URL}/image`);
  const image = /(\/[^"'\s]*_next\/image\?url=[^"'\s]+)/.exec(imagePage);
  if (!image) throw new Error("No /_next/image URL referenced by /image");

  return {
    "static-asset": { url: `${ORIGIN}${chunk[1]}` },
    static: { url: `${BASE_URL}/static` },
    isr: { url: `${BASE_URL}/isr` },
    ssr: { url: `${BASE_URL}/ssr` },
    stream: { url: `${BASE_URL}/stream` },
    // A client-side navigation's RSC payload request
    // Next.js redirects an RSC request whose `_rsc` does not hash its router
    // headers; with none of them sent, the expected value is empty.
    rsc: { url: `${BASE_URL}/ssr?_rsc`, headers: { RSC: "1" } },
    api: { url: `${BASE_URL}/api/dynamic` },
    image: {
      url: `${ORIGIN}${image[1]!.replace(/&amp;/g, "&")}`,
      headers: { Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
    },
  };
}

function getText(url: string): string {
  const res = http.get(url, {
    responseType: "text",
    headers: COOKIE ? { Cookie: COOKIE } : {},
    tags: { name: "setup" },
  });
  if (res.status !== 200 || typeof res.body !== "string" || !res.body.includes("data-bench")) {
    throw new Error(`${url} answered ${res.status}; is this the bench app?`);
  }
  return res.body;
}
