# cdk-nextjs Example App

Example Next.js app based on [App Playground](https://app-router.vercel.app/) with various configurations to showcase features of cdk-nextjs.

## Setup

1. Follow setup steps in parent README [Contributing](../README.md#contributing) section
1. Install dependencies: `cd examples && pnpm i`
1. `cd cloudfront-lambda` for example. Tryout any of the other examples as well.
1. Create .env with `AWS_PROFILE="your-profile"` in each package you want to deploy. For setting up `AWS_PROFILE`, see: [AWS security credentials](https://docs.aws.amazon.com/IAM/latest/UserGuide/security-creds.html). Ensure `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` env vars are resolved during synthesis. See more at: [How to specify environments with the AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/configure-env.html).
1. Within package, run: `pnpm deploy:local`

# Notes on app-playground

The app-playground app comes from https://github.com/vercel/app-playground. In order to incorporate upstream changes, follow instructions [here](https://stackoverflow.com/a/24816134/9658768). Don't want to use git submodule because we need to make some modifications to code like add `output: 'standalone'` and including in pnpm monorepo.
