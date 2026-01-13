# Development Guide

Helpful tips for developing cdk-nextjs.

## Tailing Lambda Logs

This is so you don't have to jump between CloudWatch Logs Groups

```bash
AWS_PROFILE="stickb-cdk-nextjs" aws logs start-live-tail --log-group-identifier "arn:aws:logs:us-east-1:1234567890:log-group:/aws/lambda/dev-glbl-fns-NextjsNextjsFunctions9D230BB2-abeepwNP249n"
```

## Debugging Containers

If you want run the Lambda or Fargate container locally you can do: `docker run -it <AWS_ACCOUNT>.dkr.ecr.<AWS_REGION>.amazonaws.com/cdk-hnb659fds-container-assets-<AWS_ACCOUNT>-<AWS_REGION>:<HASH> /bin/sh`.

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

## Local Development with Next.js Adapter

When developing the Next.js adapter and cache handler locally, you'll encounter an issue with Turbopack's filesystem root constraints. The adapter files need to be in `node_modules/cdk-nextjs/lib/adapter/` to resolve via package exports (`cdk-nextjs/adapter` and `cdk-nextjs/cache-handler`).

### The Problem

Using pnpm's `link:../..` dependency creates symlinks that point outside Turbopack's filesystem root (the Next.js app directory). Turbopack rejects these symlinks with errors like:

```
Symlink app-playground/node_modules/cdk-nextjs/package.json is invalid,
it points out of the filesystem root
```

Expanding Turbopack's root to include the entire monorepo causes it to repeatedly scan multiple `node_modules` directories, creating infinite loops and build hangs.

### The Solution (Hack)

The `examples/app-playground/package.json` includes a `prebuild` script that copies the necessary files directly into `node_modules` without symlinks:

```json
"prebuild": "rm -rf node_modules/cdk-nextjs && mkdir -p node_modules/cdk-nextjs/lib/adapter && cp ../../package.json node_modules/cdk-nextjs/package.json && cp ../../lib/adapter/adapter.mjs node_modules/cdk-nextjs/lib/adapter/adapter.mjs && cp ../../lib/adapter/cache-handler.mjs node_modules/cdk-nextjs/lib/adapter/cache-handler.mjs"
```

This runs automatically before `pnpm build`, ensuring fresh copies of the adapter files are present. While hacky, it:

- Avoids symlink issues entirely
- Keeps Turbopack's root narrow
- Simulates real npm package installation
- Enables proper package export resolution

For iterative development, just run `pnpm build` from the root to rebuild the adapter, then `pnpm build` in the example app—prebuild will copy the latest version.
