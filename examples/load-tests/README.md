# cdk-nextjs Load Tests

## Prereqs

1. Create .env with `AWS_PROFILE` and `E2E_BASE_URL`

## Test Scripts

_AWS Fargate allows up to 16 vCPUs per worker. See [here](https://www.artillery.io/docs/playwright#cost-estimation-example)_

- `pnpm test-fargate:sm` -> 100 concurrent users (count = 100 / 16 ~ 7)
- `pnpm test-fargate:md` -> 500 concurrent users (count = 500 / 16 ~ 32)
- `pnpm test-fargate:lg` -> 1,000 concurrent users (count = 1,000 / 16 ~ 63)
- `pnpm test-fargate:xl` -> 10,000 concurrent users (count = 10,000 / 16 ~ 625)

Note, the number of concurrent users above is tested during "Spike test" scenario in load-tests.ts
