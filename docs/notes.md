# Development Notes

## Mapping Next.js output to EFS and S3

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

We could ship this off to Lambda/Fargate and call it a day, but then we wouldn't have a content delivery network serving our static assets nor a shared cache between compute containers. We use S3/CloudFront for serving static assets and EFS for shared cache between compute containers.

### S3

.next/static is simply copied to S3 and then CloudFront is configured to forward requests with paths match `\_next/static` or any paths in `public` folder to S3. `NextjsAssetsDeployment` is responsible for this. We also add S3 User Metadata with `BUILD_ID` to track which static files are apart of which deployment so we can prune later - see [Pruning](#pruning).

Note, with `NextjsRegionalContainers`, we unfortunately cannot configure ALB to forward static requests directly to S3 because the host header dictates which bucket you can route requests to and it's not reliable to manually name buckets based on your domain. Therefore, static assets are copied into the container image to be served in ECS Fargate.

### EFS

EFS is used to share cached data between compute containers (ECS or Lambda). In order to not modify internals of Next.js or write a [custom server](https://nextjs.org/docs/pages/guides/custom-server) for Next.js, cdk-nextjs uses symlinks to make it so that when Next.js writes cache data to it's regular location, it's actually writing data to EFS.

EFS is mounted to either Lambda or Fargate at `/mnt/cdk-nextjs/BUILD_ID`. `BUILD_ID` is important because it lets us have deployment 123 serving users while we run deployment 456 in background and the new cache files uploaded into EFS don't affect deployment 123. Next.js has several cache types:

- Data Cache (.next/cache/fetch-cache)
- Image Optimization Cache (.next/cache/images)
- Full Route Cache (.next/standalone/relative/path/to/package/.next/server/app)

Next.js' `public` folder is symlinked to EFS too so that large image assets (often in public folder) don't weigh down compute container startup. `public` folder needs to be accessible in compute container for image optimization.

The way we initialize the EFS Mount on deployment is via `NextjsAssetDeployment` custom resource. We copy files from the custom resource lambda functions image to EFS which is mounted so that the runtime compute conatiners can access the pre-initialized caches.

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

If not pruned, then {BUILD_ID} folders could add up. See [Pruning](#pruning).

You can interact with the EFS FileSystem by deploying one of the cdk-nextjs/examples apps (like global-functions) and visiting the /run-command path. See [Verifying EFS](#verifying-efs) for more details. and entering in a command like `ls -a /mnt/cdk-nextjs/{BUILD_ID}`. Note `-a` is important otherwise dot folders don't show.

## Verifying EFS and Symlinks

Deploy one of the example apps in cdk-nextjs/examples and visit the /run-command path. You can run commands on your compute (Lambda or Fargate) to verify EFS.

1. Command: `ls /mnt/cdk-nextjs`. Expected Output: single directory with cryptic
   build id name like `fl3ApPOXn9eqhtodvoB98` unless during deployment you'll see 2.
2. Command: `ls -a /mnt/cdk-nextjs/{BUILD_ID}`. Expect to see .next and public directories
3. Command: `ls -a /mnt/cdk-nextjs/{BUILD_ID}/public`. Expect to see your public directory contents.
4. Command: `ls -a /mnt/cdk-nextjs/{BUILD_ID}/.next`. Expect to see cache and server directories.
5. Command: `ls -a /mnt/cdk-nextjs/{BUILD_ID}/.next/cache`. Expect to see fetch-cache and images folder
6. Command: `readlink public`. Expect: `/mnt/cdk-nextjs/{BUILD_ID}/public`.
7. Command: `readlink .next/cache/fetch-cache`. Expect: `/mnt/cdk-nextjs/{BUILD_ID}/.next/cache/fetch-cache`.
8. Command: `readlink .next/cache/images`. Expect: `/mnt/cdk-nextjs/{BUILD_ID}/.next/cache/images`.

Note, for `.next/cache/fetch-cache` and `.next/cache/images` you may expect to be able to do `readlink` on nested files but it will fail. You can verify they're symlinked by using `state` and ensuring same inode number (although verifying the symlinked parent directory is sufficient).

Note, in the past cdk-nextjs tried to only symlink html,rsc,meta,body files from compute container to EFS but this will not work because it doesn't allow for Next.js to generate static html,rsc,meta,body files at runtime which happens with on-demand SSG. See ssg/[id]/page.tsx in examples/app-playground. This was resolved by providing custom `cacheHandler` to read/write to EFS. This is done programatically (unknown by consumer) by editing standalone/relative/path/to/package/server.js.

## Blue Green Deployments

In a blue green deployment, you have blue already running and then you deploy a green set of resources that can handle traffic separately from blue and then you instantly or gradually switch from blue to green. Finally you decommission blue and green now becomes blue.

I'd like to bake this into cdk-nextjs if it was easy, but it's not. AWS has CodeDeploy to help with this but it's focused on compute. CloudFront has Continuous Deployments feature where you create a staging distribution on each deployment that traffic can slowly be switched to. I'd imagine this would be slow and maybe not practical for most use cases of cdk-nextjs I'm sure we could come up with a solution for this in cdk-nextjs and maybe one day we will, but for now (5/21/25) there are more important features to work on.

However, the principle of B/G deployments in which you setup separate resources for each deployment and then switch over is still used in cdk-nextjs within EFS and S3. See [Pruning](#pruning)

## Pruning

Pruning removes old files from EFS and S3 so old deployment files aren't used. Pruning is done in `NextjsPostDeploy`. EFS is simple because we partition directories by BUILD_ID so we just delete the non-current build id. S3 is more complicated. First you need to understand the issue of [version skew](https://vercel.com/docs/skew-protection) where users that have Next.js apps open in tabs without refreshing for long time hold stale references to static files that don't exist anymore in current deployment.

To solve this, we could write static files to S3 and just keep overwriting files and never delete them, but this is not ideal because your bucket will keep accumulating static files that you don't need and are paying for.

The compromise cdk-nextjs takes is that `NextjsPostDeploy` looks at all objects in the bucket each time and reads the object's metadata to see what the "next-build-id" is. "next-build-id" is set in `NextjsStaticAssetsDeployment`. If it's not the current deployment's build id AND last modified < `new Date() - msTtl` then it is deleted. `msTtl` is configurable and by default is 1 month.

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

We omit storing .js and .nft.json files in EFS because they're static and don't change. The .js and .nft.json files live in the compute image and are run when `node index.js` runs. They'd be duplicative in EFS. Similarly the .rsc, .html .body, and .meta files are duplicative in the compute image.

## Debugging Containers

If you want to debug the cdk-nextjs builder image and you've run `cdk deploy` locally, then you can run `docker run -it cdk-nextjs/builder:<HASH> /bin/sh` replacing `<HASH>`. You can find out what this is by looking at the logs after you run `cdk deploy`. Note, the builder image is not uploaded to ECR. The built Next.js app inside this container is copied from by the runtime image and assets deployment image.

If you want to debug the assets deployment image you need to run something like: `docker run -it --entrypoint /bin/bash <AWS_ACCOUNT>.dkr.ecr.<AWS_REGION>.amazonaws.com/cdk-hnb659fds-container-assets-<AWS_ACCOUNT>-<AWS_REGION>:<HASH>`. `--entrypoint` is required because the base image is `public.ecr.aws/lambda/nodejs:22`.

### Authenticating to ECR For Non-Local Built Containers

Sometimes you'll want to run the containers built by cdk-nextjs that were not built locally. You'll run command like: `docker run -it <AWS_ACCOUNT>.dkr.ecr.<AWS_REGION>.amazonaws.com/cdk-hnb659fds-container-assets-<AWS_ACCOUNT>-<AWS_REGION>:<HASH> /bin/sh`. In order to authenticate, you'll need to update your `~/.docker/config.json`. Assuming you're using macOS and [Rancher Desktop](https://rancherdesktop.io/) which by default includes the [amazon-ecr-credential-helper](https://github.com/awslabs/amazon-ecr-credential-helper). Here is example below:

```json
{
  "auths": {
    "<AWS_ACCOUNT>.dkr.ecr.<AWS_REGION>.amazonaws.com": {}
  },
  "credsStore": "osxkeychain",
  "credHelpers": {
    "<AWS_ACCOUNT>.dkr.ecr.<AWS_REGION>.amazonaws.com": "ecr-login"
  },
  "currentContext": "rancher-desktop"
}
```

NOTE, you'll need to remove `credsHelpers` when you want to use `cdk deploy` again because CDK is not compatible with `amazon-ecr-credential-helper`. I recommend just renaming to `_credsHelpers` so you can quickly use it again if needed.

## builder.Dockerfile

It's recommended by Docker [here](https://docs.docker.com/reference/dockerfile/#env) to limit scope of env vars. So for builder.Dockerfile injection, we don't do `ENV {{INJECT_CDK_NEXTJS_BUILD_ENV_VARS}}`, rather we do `RUN {{INJECT_CDK_NEXTJS_BUILD_ENV_VARS}} next build`.
