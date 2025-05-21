# Development Notes

## Mapping Next.js output to EFS and S3

When a Next.js app is built with `next build` with standalone mode it's output looks like:

```
- public
- .next
  - cache
    - fetch-cache
    - images
  - standalone
    - relative-path-to-workspace
      - .next
        - server
          - app
  - static
```

Notes:

- .next/cache/images won't show up at first, it's written to as app is used
- .next/cache/fetch-cache will only show up if you have `fetch` data to cache

We could ship this off to Lambda/Fargate and call it a day, but then we wouldn't
have a content delivery network serving our static assets nor a shared cache
between compute containers. We use S3/CloudFront for serving static assets
and EFS for shared cache between compute containers.

## S3

.next/static is simply copied to S3 and then CloudFront is configured to forward
\_next/static requests to S3. We'd prefer to prefix the S3 path with Next.js BUILD_ID
to prevent static assets from leaking into future deployments but this is difficult
to coordinate with deploying compute.

## EFS

EFS is mounted to either Lambda or Fargate at `/mnt/cdk-nextjs/BUILD_ID`. `BUILD_ID`
is important because it lets us have deployment 1 serving users while we
run deployment 2 in background and the new cache files uploaded into EFS don't
affect deployment 1. Next.js has several cache types:

- Data Cache (.next/cache/fetch-cache)
- Image Optimization Cache (.next/cache/images)
- Full Route Cache (.next/standalone/relative-path-to-workspace/.next/server/app)

While data cache and image optimization cache when built are located at .next/cache,
for standalone output they need to be moved to .next/standalone/relative-path-to-workspace/.next/cache
to be used while running in standalone mode. public folder is required because
images are often optimized from the public folder and we'd rather store the
public folder in EFS than in compute container to reduce image size to save on
cold start. The full route cache contains .html, .rsc, .meta, and .body files
that can be updated overtime as a part of Incremental Static Regeneration (ISR).

Next.js exports a `FileSystemCache` that we customize to support the Data Cache
and Full Route Cache being updated in EFS mount path instead of where the
Next.js app is running from. We customize the `serverDistDir` key of the object
input parameter. See below

```ts
export default class CacheHandler extends FileSystemCache {
  constructor(options: ConstructorParameters<typeof FileSystemCache>[0]) {
    super({ ...options, serverDistDir: process.env.CDK_NEXTJS_SERVER_DIST_DIR });
  }
```

We can customize the location of the image optimization cache or public folder
this way so we have to use symlinks.

The way we initialize the EFS Mount on deployment is via `NextjsAssetDeployment`
custom resource. We copy files from the custom resource lambda functions image
to EFS which is mounted so that the runtime compute conatiners can access
the pre-initialized caches.

Here is structure of EFS File System which maps similarly to Next.js build output:

- root
  - {BUILD_ID}
    - public
    - .next
      - cache
        - fetch-cache
        - images
      - server
        - app

You can interact with the EFS FileSystem by deploying one of the cdk-nextjs/examples
apps (like global-functions) and visiting the /run-command path and entering in
a command like `ls /mnt/{BUILD_ID}`.
