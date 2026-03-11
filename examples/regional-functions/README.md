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

#### 3. Image Path Prefixing

```typescript
// For static images that Next.js Image optimization needs to fetch
<Image src={getImageSrc('/static/image.jpg')} ... />
```

The `getImageSrc()` helper adds the `/prod` prefix to image src paths when `NEXT_PUBLIC_IMAGE_SRC_PREFIX` is set.

### Why Both Middleware and NEXT_PUBLIC_IMAGE_SRC_PREFIX?

- **Middleware**: Reconstructs the full path by prepending the stage name (from `x-amzn-request-context` header) that Lambda Web Adapter doesn't include in the URL path
- **NEXT_PUBLIC_IMAGE_SRC_PREFIX**: Ensures Next.js Image optimization requests source images with the correct `/prod/static/*` path, so they route correctly through API Gateway

### Request Flow Example

**Page Request:**

1. Browser: `GET /prod/api/health`
2. API Gateway → Lambda Web Adapter → Next.js: `GET /api/health` (stage in header, not path)
3. Middleware reads `x-amzn-request-context` header and rewrites: `/api/health` → `/prod/api/health`
4. Next.js routes correctly with basePath

**Image Optimization:**

1. Browser: `GET /prod/_next/image?url=/prod/static/image.jpg`
2. Next.js Image optimization fetches source: `GET /prod/static/image.jpg`
3. Request routes through API Gateway correctly
4. Image optimized and returned

## Usage

```bash
pnpm run deploy
```

Access your app at: `https://YOUR_API_ID.execute-api.REGION.amazonaws.com/prod/`

**Note:** With a custom domain, none of this complexity is needed since you can route directly to the Lambda Function URL or use path mappings.
