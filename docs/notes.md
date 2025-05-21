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

### S3

.next/static is simply copied to S3 and then CloudFront is configured to forward
\_next/static requests to S3.

### EFS

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
a command like `ls -a /mnt/cdk-nextjs/{BUILD_ID}`. Note `-a` is important otherwise
dot folders don't show.

## Blue Green Deployments

In a blue green deployment, you have blue already running and then you deploy
a green set of resources that can handle traffic separately from blue and then
you instantly or gradually switch from blue to green. Finally you decommission blue
and green now becomes blue.

I'd like to bake this into cdk-nextjs if it was easy, but it's not. AWS has
CodeDeploy to help with this but it's focused on compute. CloudFront has Continuous
Deployments feature where you create a staging distribution on each deployment
that traffic can slowly be switched to. I'd imagine this would be slow and
maybe not practical for most use cases of cdk-nextjs I'm sure we could come up
with a solution for this in cdk-nextjs and maybe one day we will, but for now (5/21/25)
there are more important features to work on.

However, the principle of B/G deployments in which you setup separate resources
for each deployment and then switch over is still used in cdk-nextjs within EFS
and S3. See [Pruning](#pruning)

## Pruning

Pruning removes old files from EFS and S3 so old deployment files aren't used.
Pruning is done in `NextjsPostDeploy`. EFS is simple because we partition
directories by BUILD_ID so we just delete the non-current build id. S3 is more
complicated. First you need to understand the issue of [version skew](https://vercel.com/docs/skew-protection)
where users that have Next.js apps open in tabs without refreshing for long
time hold stale references to static files that don't exist anymore in
current deployment.

To solve this, we could write static files to S3 and just keep overwriting
files and never delete them, but this is not ideal because your bucket will keep
accumulating static files that you don't need and are paying for.

The compromise cdk-nextjs takes is that `NextjsPostDeploy` looks at all objects
in the bucket each time and reads the object's metadata to see what the "next-build-id"
is. "next-build-id" is set in `NextjsStaticAssetsDeployment`. If it's not the
current deployment's build id AND last modified < `new Date() - msTtl` then it is
deleted. `msTtl` is configurable and by default is 1 month.

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

### Impact on cdk-nextjs

We omit storing .js and .nft.json files in EFS because they're static and don't
change. The .js and .nft.json files live in the compute image and are run
when `node index.js` runs. They'd be duplicative in EFS. Similarly the .rsc, .html
.body, and .meta files are duplicative in the compute image.
