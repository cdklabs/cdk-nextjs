# Development Guide

Helpful tips for developing cdk-nextjs.

## Tailing Lambda Logs

This is so you don't have to jump between CloudWatch Logs Groups

```bash
AWS_PROFILE="stickb-cdk-nextjs" aws logs start-live-tail --log-group-identifier "arn:aws:logs:us-east-1:1234567890:log-group:/aws/lambda/dev-glbl-fns-NextjsNextjsFunctions9D230BB2-abeepwNP249n"
```

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
