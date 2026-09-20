# NextjsRegionalFunctions Example

This example demonstrates deploying a Next.js application using `NextjsRegionalFunctions` with API Gateway REST API.

## API Gateway Stage Path Handling

When using API Gateway REST API without a custom domain, all requests go through a stage path (default: `/prod`). This requires special handling:

### The Challenge

1. **External Request**: Browser requests `https://api-gateway-url/prod/api/health`
2. **API Gateway sends to Lambda**: `event.path = "/api/health"` + `event.requestContext.stage = "prod"` (path and stage are separate)
3. **Lambda Web Adapter translates**: Forwards path as `/api/health` to Next.js (stage not in path, but available in `x-amzn-request-context` header)
4. **Next.js expects basePath**: With `basePath: "/prod"` in next.config.ts, Next.js expects `/prod/api/health`
5. **Result**: 404 error without middleware to reconstruct the full path

### The Solution

This example uses a three-part approach:

#### 1. Next.js basePath Configuration

```typescript
// next.config.ts
basePath: process.env['NEXTJS_BASE_PATH'], // Set to "/prod" at build time
```

#### 2. Middleware Path Rewriting

```typescript
// proxy.ts
// Lambda Web Adapter provides stage via x-amzn-request-context header
// Reconstruct the full path by prepending the stage name
if (reqCtxStr) {
  url.pathname = `/${stage}${url.pathname}`;
  return NextResponse.rewrite(url);
}
```

#### 3. Image Path Prefixing (raw URLs only)

```typescript
// Only for raw, browser-fetched URLs (e.g. CSS background-image) — do NOT
// wrap <Image src=...> with this. next/image already accounts for basePath
// on its own (see "Image Optimization" below), and the dedicated image
// optimization Lambda strips basePath itself before resolving the S3 key.
<div style={{ backgroundImage: `url('${getImageSrc('/static/grid.svg')}')` }} />
```

The `getImageSrc()` helper adds the `/prod` prefix to a path when `NEXT_PUBLIC_IMAGE_SRC_PREFIX` is set. It's needed for URLs the browser fetches directly (not through `next/image`), since those aren't routed through basePath at all — everything else (`<Image src=...>`, page links) is handled automatically by Next.js/API Gateway/the image Lambda without it.

### Why Both Middleware and NEXT_PUBLIC_IMAGE_SRC_PREFIX?

- **Middleware**: Reconstructs the full path by prepending the stage name (from `x-amzn-request-context` header) that Lambda Web Adapter doesn't include in the URL path
- **NEXT_PUBLIC_IMAGE_SRC_PREFIX**: Prefixes raw, browser-fetched asset URLs (CSS `background-image`, etc.) that never go through basePath-aware Next.js routing

### Request Flow Example

**Page Request:**

1. Browser: `GET /prod/api/health`
2. API Gateway → Lambda Web Adapter → Next.js: `GET /api/health` (stage in header, not path)
3. Middleware reads `x-amzn-request-context` header and rewrites: `/api/health` → `/prod/api/health`
4. Next.js routes correctly with basePath

**Image Optimization:**

`_next/image` is served by the server function, so Next.js middleware runs for image requests:

1. Browser: `GET /prod/_next/image?url=/static/image.jpg` (plain string paths in `<Image src>` are passed through unprefixed by `next/image`; the `/prod` on the request itself comes from `basePath`)
2. API Gateway routes `/prod/_next/image` to the server function via the `{proxy+}` catch-all
3. Next.js fetches the source image back through API Gateway and returns the optimized image

## Usage

```bash
pnpm run deploy
```

Access your app at: `https://YOUR_API_ID.execute-api.REGION.amazonaws.com/prod/`

**Note:** With a custom domain, none of this complexity is needed since you can route directly to the Lambda Function URL or use path mappings.
