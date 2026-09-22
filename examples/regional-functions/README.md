# NextjsRegionalFunctions Example

This example demonstrates deploying a Next.js application using `NextjsRegionalFunctions` with API Gateway REST API.

## API Gateway Stage Path Handling

When using API Gateway REST API without a custom domain, all requests go through a stage path (default: `/prod`). This requires special handling:

### The Challenge

1. **External Request**: Browser requests `https://api-gateway-url/prod/api/health`
2. **API Gateway sends to Lambda**: `event.path = "/api/health"` + `event.requestContext.stage = "prod"` (path and stage are separate)
3. **cdk-nextjs's Lambda shell hands Next.js the path it was given**: `/api/health`, deliberately — `requestContext.path` would carry the stage, but it is the resource path and matches nothing Next.js built
4. **Next.js expects basePath**: With `basePath: "/prod"` in next.config.ts, Next.js expects `/prod/api/health`
5. **Result**: 404 error without a proxy (middleware) to reconstruct the full path

### The Solution

This example uses a three-part approach:

#### 1. Next.js basePath Configuration

```typescript
// next.config.ts
basePath: process.env['NEXTJS_BASE_PATH'], // Set to "/prod" at build time
```

#### 2. Proxy Path Rewriting

```typescript
// proxy.ts
// Reconstruct the full path by prepending the stage name, which the Lambda
// event carries separately from the path.
url.pathname = `/${stage}${url.pathname}`;
return NextResponse.rewrite(url);
```

The stage comes from `API_GATEWAY_STAGE`, set on the function in `app.ts`, not from the request. Reading it per-request is not an option: Next.js re-enters the proxy for its own internal fetches with a synthetic request, so a per-request value is absent exactly where it is needed. Since the stage is fixed for the life of a deployment, an environment variable loses nothing.

#### 3. Image Path Prefixing (raw URLs only)

```typescript
// Only for raw, browser-fetched URLs (e.g. CSS background-image) — do NOT
// wrap <Image src=...> with this. next/image already accounts for basePath
// on its own (see "Image Optimization" below), and cdk-nextjs's runtime
// strips basePath itself before resolving the S3 key.
<div style={{ backgroundImage: `url('${getImageSrc('/static/grid.svg')}')` }} />
```

The `getImageSrc()` helper adds the `/prod` prefix to a path when `NEXT_PUBLIC_IMAGE_SRC_PREFIX` is set. It's needed for URLs the browser fetches directly (not through `next/image`), since those aren't routed through basePath at all — everything else (`<Image src=...>`, page links) is handled automatically by Next.js/API Gateway/cdk-nextjs's image optimizer without it.

### Why Both the Proxy and NEXT_PUBLIC_IMAGE_SRC_PREFIX?

- **Proxy**: Reconstructs the full path by prepending the stage name that the Lambda event keeps out of the URL path
- **NEXT_PUBLIC_IMAGE_SRC_PREFIX**: Prefixes raw, browser-fetched asset URLs (CSS `background-image`, etc.) that never go through basePath-aware Next.js routing

### Request Flow Example

**Page Request:**

1. Browser: `GET /prod/api/health`
2. API Gateway → Lambda → Next.js: `GET /api/health` (stage in the event, not the path)
3. The proxy prepends `API_GATEWAY_STAGE` and rewrites: `/api/health` → `/prod/api/health`
4. Next.js routes correctly with basePath

**Image Optimization:**

`_next/image` is served by the server function, and the proxy runs for image requests:

1. Browser: `GET /prod/_next/image?url=/static/image.jpg` (plain string paths in `<Image src>` are passed through unprefixed by `next/image`; the `/prod` on the request itself comes from `basePath`)
2. API Gateway routes `/prod/_next/image` to the server function via the `{proxy+}` catch-all
3. cdk-nextjs's runtime reads the source image straight out of the assets bucket — no second trip through API Gateway — and returns the optimized image

## Usage

```bash
pnpm run deploy
```

Access your app at: `https://YOUR_API_ID.execute-api.REGION.amazonaws.com/prod/`

## With a Custom Domain (No Stage Workarounds)

Everything above exists only because the execute-api endpoint puts the stage in the URL path while API Gateway strips it before invoking Lambda. Map a custom domain at the root and the stage never appears in a URL, so all of it goes away:

```ts
const nextjs = new NextjsRegionalFunctions(this, "Nextjs", {
  // No `basePath` — the app is served at the root.
  buildDirectory: join(import.meta.dirname, "..", "app-playground"),
  overrides: {
    nextjsApi: {
      restApiProps: {
        domainName: {
          domainName: "app.example.com",
          certificate, // regional ACM certificate in the same region as the API
          // No `basePath` either: mapping at the root is what removes the need
          // for every workaround below.
        },
      },
    },
  },
});
```

Then drop all four:

| Setting                        | Why it's not needed                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `basePath` in `next.config.ts` | No stage in the path, so the app's links already match the URLs the browser requests |
| `PREPEND_APIGW_STAGE`          | Nothing to re-prepend — `proxy.ts` only exists to undo the stage strip               |
| `API_GATEWAY_STAGE`            | Same; it's the stage name that rewrite prepends                                      |
| `NEXT_PUBLIC_IMAGE_SRC_PREFIX` | Raw browser-fetched URLs resolve at the root                                         |

Leave the construct's `basePath` prop unset too. Static asset routing needs no adjustment: `NextjsApi` applies `NextjsStaticAssets.keyPrefix` to its S3 integration keys, and the runtime's image optimizer keeps the app's `basePath` and the S3 key prefix separate, so with nothing set anywhere the keys resolve at the bucket root.

`nextjs.url` reports the custom domain (including a base path mapping if you configure one) rather than the execute-api endpoint.

This example doesn't use a custom domain because it would need a hosted zone and certificate that CI can't provision.
