# Next.js Output Guide

When a Next.js app is built with `next build` with standalone mode, here is a simplified version of it's output:

- public ([Public Folder](https://nextjs.org/docs/app/api-reference/file-conventions/public-folder))
- .next
  - cache
    - fetch-cache ([Data Cache](https://nextjs.org/docs/app/deep-dive/caching#data-cache))
      - 123abc
  - standalone
    - relative/path/to/package
      - .next
        - server
          - app ([Full Route Cache](https://nextjs.org/docs/app/deep-dive/caching#full-route-cache))
            - api
              - health
                - route.js
              - health.body
              - health.meta
            - my-dynamic-page
              - page.js
            - my-static-page
              - page.js
            - my-static-page.html
            - my-static-page.meta
            - my-static-page.rsc
  - static ([Static Assets](https://nextjs.org/docs/app/guides/self-hosting#static-assets))

Notes:

- .next/cache/images ([Optimized Image Cache](https://nextjs.org/docs/app/api-reference/components/image)) won't show up at first, it's generated as images are optimized during use of app
- .next/cache/fetch-cache will only show up if you have `fetch` data to cache
- [Standalone Output](https://nextjs.org/docs/pages/api-reference/config/next-config-js/output#automatically-copying-traced-files) copies only the necessary files for a production deployment including select files in node_modules which is ideal for keeping compute container image small. However, `next build` does not automatically copy the public and static folders into the standalone directory so that needs to be done.
- .body, .meta, .html, and .rsc files are updated by Next.js as a part of [ISR](https://nextjs.org/docs/app/guides/incremental-static-regeneration)

We could ship this off to Lambda/Fargate and call it a day, but then we wouldn't have a content delivery network serving our static assets nor a shared cache between compute containers. We use S3/CloudFront for serving static assets and S3/DDB for shared cache between compute containers.

## S3

.next/static is simply copied to S3 and then CloudFront is configured to forward requests with paths match `\_next/static` or any paths in `public` folder to S3. `NextjsAssetsDeployment` is responsible for this. We also add S3 User Metadata with `BUILD_ID` to track which static files are apart of which deployment so we can prune later.

Note, with `NextjsRegionalContainers`, we unfortunately cannot configure ALB to forward static requests directly to S3 because the host header dictates which bucket you can route requests to and it's not reliable to manually name buckets based on your domain. Therefore, static assets are copied into the container image to be served in ECS Fargate.

## Next.js Full Route Cache Files (.next/server/app folder) [From Amazon Q]

The files in the .next/server/app folder are part of Next.js's build output and caching system. Each file type serves a specific purpose:

- .js files:
  - These are the compiled JavaScript files that contain the server components and logic for your routes.
  - They include the actual code that runs on the server to generate your pages.
- .nft.json files:
  - NFT stands for "Node File Trace".
  - These files contain metadata about dependencies needed for a particular route.
  - They help Next.js optimize the deployment by tracking which files are needed for each route.
- .rsc files:
  - RSC stands for "React Server Component".
  - These files contain the serialized React Server Components payload.
  - They store the pre-rendered output of your server components in a format that can be efficiently transmitted to the client.
- .html files:
  - These are the static HTML files generated during the build process.
  - They represent the initial HTML that will be sent to the client for static pages.
- .body files:
  - These contain the HTML body content of your pages.
  - They're used for streaming and partial rendering optimizations.
- .meta files:
  - Cache Control Information
  - Route Configuration
  - Revalidation Timing
  - Tags for On-demand Revalidation

Files Updated During ISR (Incremental Static Regeneration)
During ISR revalidation, Next.js updates:

- .rsc files: The React Server Component payloads are regenerated with fresh data.
- .html files: The static HTML is regenerated with the updated content.
- .body files: The body content is updated to reflect the new data.
- .meta files: Updated to reflect new cache timing information and potentially updated tags.

The .js files typically remain unchanged during ISR since they contain the code logic which doesn't change. The .nft.json files also remain unchanged as the dependency structure doesn't change during revalidation.
