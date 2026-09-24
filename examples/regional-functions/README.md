# NextjsRegionalFunctions Example

This example demonstrates deploying a Next.js application using `NextjsRegionalFunctions` with API Gateway REST API.

## API Gateway Stage Path Handling

Without a custom domain, every URL of a REST API carries its stage (default: `/prod`): `https://API_ID.execute-api.REGION.amazonaws.com/prod/...`. Two things follow.

### 1. Build the app with `basePath` set to the stage

```typescript
// next.config.ts
basePath: process.env['NEXTJS_BASE_PATH'], // "/prod", set in app.ts before the build
```

So the app's links and bundle URLs carry `/prod`. Nothing at deploy time can add it to URLs already compiled into the bundles, so this is the one place the stage name has to be known. Leave the construct's `basePath` prop unset: API Gateway strips the stage before matching resources.

### 2. Nothing else

API Gateway strips the stage from the path it passes to Lambda — `/prod/api/health` arrives as `event.path = "/api/health"` — while the app only routes `/prod/api/health`. cdk-nextjs's Lambda shell handles that: for an app whose `basePath` starts with the prefix API Gateway stripped, it hands Next.js `requestContext.path`, which still carries it. The stage is read off each request, so a stage named `test` or a renamed one needs no configuration, and no middleware is involved.

### Raw browser-fetched URLs

```typescript
<div style={{ backgroundImage: `url('${getImageSrc('/static/grid.svg')}')` }} />
```

Next.js prefixes links, `<Image>` and bundle URLs with `basePath`, but not a string the browser fetches directly, such as a CSS `background-image`. The `getImageSrc()` helper adds `NEXT_PUBLIC_IMAGE_SRC_PREFIX` (`/prod`) to those. This is true of any `basePath` deployment, not just API Gateway. Don't wrap `<Image src=...>` with it: `next/image` already accounts for `basePath`, and cdk-nextjs's image optimizer strips it before resolving the S3 key.

## Usage

```bash
pnpm run deploy
```

Access your app at: `https://YOUR_API_ID.execute-api.REGION.amazonaws.com/prod/`

## With a Custom Domain (No Stage Workarounds)

Everything above exists only because the execute-api endpoint puts the stage in the URL path. Map a custom domain at the root and the stage never appears in a URL, so all of it goes away:

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

Then drop both:

| Setting                        | Why it's not needed                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `basePath` in `next.config.ts` | No stage in the path, so the app's links already match the URLs the browser requests |
| `NEXT_PUBLIC_IMAGE_SRC_PREFIX` | Raw browser-fetched URLs resolve at the root                                         |

With nothing stripped, the Lambda shell hands Next.js the path unchanged. A base path mapping (`basePath: "app"` on the domain) is stripped like a stage is, so an app built with `basePath: "/app"` behind one gets the same treatment — expected from the `requestContext.path` behavior AWS documents, but untested here for lack of a hosted zone.

Leave the construct's `basePath` prop unset too. Static asset routing needs no adjustment: `NextjsApi` applies `NextjsStaticAssets.keyPrefix` to its S3 integration keys, and the runtime's image optimizer keeps the app's `basePath` and the S3 key prefix separate, so with nothing set anywhere the keys resolve at the bucket root.

`nextjs.url` reports the custom domain (including a base path mapping if you configure one) rather than the execute-api endpoint.

This example doesn't use a custom domain because it would need a hosted zone and certificate that CI can't provision.
