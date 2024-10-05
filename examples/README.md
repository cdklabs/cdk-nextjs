# cdk-nextjs Example App

Example Next.js app based on [App Playground](https://app-router.vercel.app/) with various configurations to showcase features of cdk-nextjs.

## Setup

1. Follow setup steps in parent README [Contributing](../README.md#contributing) section
1. Install dependencies: `cd examples && pnpm i`
1. `cd cloudfront-lambda` for example. Tryout any of the other examples as well.
1. `cdk deploy --require-approval never`

# Notes on app-playground

The app-playground app comes from https://github.com/vercel/app-playground. In order to incorporate upstream changes, follow instructions [here](https://stackoverflow.com/a/24816134/9658768). Don't want to use git submodule because we need to make some modifications to code like add `output: 'standalone'` and including in pnpm monorepo.
